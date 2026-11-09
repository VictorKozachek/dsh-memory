/**
 * Тесты `memory.search`: FTS5 + bm25, топ-k, фильтры `kinds`/`status`/
 * `namespace`, отсечение `stale`, пометка `draft`, сниппет ≤ 300 символов,
 * пустой/невалидный запрос и отличие «ничего не найдено» от поломки БД.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openStore } from '../lib/store.js'
import { DEFAULT_K, DEFAULT_SNIPPET_CHARS, DEFAULT_STATUS, SEARCH_STATUSES, searchMemory } from '../lib/search.js'

/** Открыть хранилище на временном каталоге; закрывается после теста. */
function tempStore(t, namespace = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-search-'))
  const store = openStore({ dbPath: dir, namespace })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

/** Базовый набор записей: verified, draft, stale, decision и ответ. */
function seed(store) {
  const verified = store.insertEntry({
    kind: 'fact',
    title: 'Хранилище',
    text: 'Память проекта живёт в SQLite и переживает сессии',
    status: 'verified',
    confidence: 1,
    sourcePath: 'docs/storage.md',
  })
  const draft = store.insertEntry({
    kind: 'fact',
    title: 'Черновик',
    text: 'Память на FTS5 пока черновик',
    status: 'draft',
    confidence: 0.4,
  })
  const stale = store.insertEntry({
    kind: 'fact',
    title: 'Устаревшее',
    text: 'Устаревшая память проекта',
    status: 'stale',
    confidence: 1,
  })
  const decision = store.insertEntry({
    kind: 'decision',
    title: 'Решение',
    text: 'Поиск памяти делаем через FTS5',
    status: 'verified',
    confidence: 1,
    sourceRef: 'task/004',
  })
  const answer = store.insertEntry({
    kind: 'answer',
    title: 'Ответ',
    text: 'Память проекта на SQLite, ответ для агента',
    status: 'verified',
    confidence: 0.8,
  })
  return { verified, draft, stale, decision, answer }
}

test('контракт: дефолты и допустимые статусы', () => {
  assert.deepEqual(SEARCH_STATUSES, ['verified', 'all'])
  assert.equal(DEFAULT_STATUS, 'verified')
  assert.equal(DEFAULT_K, 10)
  assert.equal(DEFAULT_SNIPPET_CHARS, 300)
})

test('stale не возвращается никогда, ни при каком status', (t) => {
  const store = tempStore(t)
  const { stale } = seed(store)

  for (const status of ['verified', 'all']) {
    const results = searchMemory(store, { query: 'память', status })
    assert.ok(results.length > 0, `пусто для status=${status}`)
    assert.ok(!results.some((result) => result.id === stale.id), `stale попал в выдачу при status=${status}`)
  }
})

test('по умолчанию возвращаются только verified, draft — при status: all с пометкой', (t) => {
  const store = tempStore(t)
  const { draft } = seed(store)

  const verifiedOnly = searchMemory(store, { query: 'память' })
  assert.ok(verifiedOnly.length > 0)
  assert.ok(verifiedOnly.every((result) => result.status === 'verified'))
  assert.ok(!verifiedOnly.some((result) => result.id === draft.id), 'draft попал в выдачу по умолчанию')

  const all = searchMemory(store, { query: 'память', status: 'all' })
  const draftResult = all.find((result) => result.id === draft.id)
  assert.ok(draftResult, 'draft не найден при status: all')
  assert.equal(draftResult.status, 'draft', 'draft должен быть помечен статусом')
})

test('defaultStatus из конфига перекрывает дефолт инструмента', (t) => {
  const store = tempStore(t)
  const { draft } = seed(store)

  const results = searchMemory(store, { query: 'память' }, { defaultStatus: 'all' })
  assert.ok(results.some((result) => result.id === draft.id))
})

test('фильтр kinds сужает выдачу', (t) => {
  const store = tempStore(t)
  const { decision, draft } = seed(store)

  const decisions = searchMemory(store, { query: 'FTS5', status: 'all', kinds: ['decision'] })
  assert.deepEqual(decisions.map((result) => result.id), [decision.id])

  const facts = searchMemory(store, { query: 'FTS5', status: 'all', kinds: ['fact'] })
  assert.deepEqual(facts.map((result) => result.id), [draft.id])

  assert.deepEqual(searchMemory(store, { query: 'FTS5', kinds: [] }), [])
})

test('k ограничивает выборку, сортировка по score (bm25) по возрастанию', (t) => {
  const store = tempStore(t)
  seed(store)

  const all = searchMemory(store, { query: 'SQLite', status: 'all' })
  assert.ok(all.length >= 2)
  for (let index = 1; index < all.length; index += 1) {
    assert.ok(all[index - 1].score <= all[index].score, 'результаты не отсортированы по score')
    assert.ok(all[index].score <= 0, 'bm25 должен быть неположительным')
  }

  const limited = searchMemory(store, { query: 'SQLite', status: 'all', k: 1 })
  assert.equal(limited.length, 1)
  assert.equal(limited[0].id, all[0].id)
})

test('сниппет ≤ 300 символов, окно вокруг совпадения, без полного текста', (t) => {
  const store = tempStore(t)
  const longText = `Память проекта. ${'слово '.repeat(150)}конец`
  const { id } = store.insertEntry({ kind: 'doc', title: 'Длинный', text: longText, status: 'verified', confidence: 1 })

  const [result] = searchMemory(store, { query: 'слово', status: 'all' })
  assert.equal(result.id, id)
  assert.ok(result.snippet.length <= DEFAULT_SNIPPET_CHARS, `сниппет длиннее 300: ${result.snippet.length}`)
  assert.ok([...result.snippet].length <= DEFAULT_SNIPPET_CHARS)
  assert.ok(result.snippet.includes('слово'))
  assert.ok(result.snippet.endsWith('…'), 'длинный текст должен обрезаться многоточием')
  assert.equal(result.text, undefined, 'полный текст не должен попадать в результат')

  assert.deepEqual(Object.keys(result).sort(), [
    'confidence',
    'id',
    'score',
    'snippet',
    'source_path',
    'source_ref',
    'status',
    'title',
  ])

  const short = searchMemory(store, { query: 'слово', status: 'all' }, { snippetChars: 80 })
  assert.ok(short[0].snippet.length <= 80)
})

test('пустой и невалидный запрос дают пустой массив, а не исключение', (t) => {
  const store = tempStore(t)
  seed(store)

  for (const input of [
    { query: '' },
    { query: '   ' },
    { query: undefined },
    { query: 42 },
    {},
    undefined,
    null,
  ]) {
    assert.deepEqual(searchMemory(store, input), [], `запрос ${JSON.stringify(input)} должен дать []`)
  }
  for (const query of ['ИЛИ (', '"незакрытая', '*', 'AND']) {
    assert.deepEqual(searchMemory(store, { query, status: 'all' }), [], `невалидный FTS5-запрос "${query}" должен дать []`)
  }
})

test('namespace фильтрует выдачу', (t) => {
  const store = tempStore(t)
  seed(store)

  assert.ok(searchMemory(store, { query: 'память', namespace: store.namespace }).length > 0)
  assert.deepEqual(searchMemory(store, { query: 'память', namespace: 'другой-воркспейс' }), [])
})

test('null в необязательных полях считается отсутствующим', (t) => {
  const store = tempStore(t)
  seed(store)

  const results = searchMemory(store, { query: 'память', k: null, kinds: null, status: null, namespace: null })
  assert.ok(results.length > 0)
  assert.ok(results.every((result) => result.status === 'verified'))
})

test('невалидные k/status/kinds/namespace — понятная ошибка контракта', (t) => {
  const store = tempStore(t)
  seed(store)

  assert.throws(() => searchMemory(store, { query: 'память', k: 0 }), /k должен быть целым/)
  assert.throws(() => searchMemory(store, { query: 'память', k: '2' }), /k должен быть целым/)
  assert.throws(() => searchMemory(store, { query: 'память', status: 'stale' }), /status должен быть/)
  assert.throws(() => searchMemory(store, { query: 'память', kinds: 'fact' }), /kinds должен быть массивом/)
  assert.throws(() => searchMemory(store, { query: 'память', namespace: '  ' }), /namespace/)
  assert.throws(() => searchMemory(store, 'память'), /memory\.search ждёт объект/)
})

test('поломка FTS не маскируется под «ничего не найдено»', (t) => {
  const store = tempStore(t)
  seed(store)
  store.database.exec('DROP TABLE entries_fts')

  assert.throws(() => store.searchEntries('память'), /no such table: entries_fts/)
  assert.throws(() => searchMemory(store, { query: 'память' }), /no such table: entries_fts/)
})
