/**
 * Тесты лексического поиска без векторов (задача 020): Snowball-стеммер,
 * словоформы, опечатки через trigram-fallback, синонимы из локального словаря
 * и отдельный канал verified Q&A.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { compareBenchmark } from '../lib/benchmark.js'
import { buildLexMatch, buildTrigramMatch, searchMemory, trigramSimilarity } from '../lib/search.js'
import { stemText, stemTokens, stemWord, stemWordLoose } from '../lib/stemmer.js'
import { openStore } from '../lib/store.js'

/** Открыть хранилище на временном каталоге; закрывается после теста. */
function tempStore(t, namespace = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-lex-'))
  const store = openStore({ dbPath: dir, namespace })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

/** Запись с текстом; verified по умолчанию. */
function add(store, title, text, overrides = {}) {
  return store.insertEntry({
    kind: 'doc',
    title,
    text,
    status: 'verified',
    confidence: 1,
    ...overrides,
  })
}

test('Snowball: словоформы индексатора и индексации сводятся к основе; мягкие основы — тоже', () => {
  assert.equal(stemWord('индексатора'), stemWord('индексатор'))
  assert.equal(stemWord('индексатору'), stemWord('индексатор'))
  assert.equal(stemWord('индексации'), stemWord('индексация'))
  assert.equal(stemWord('индексацией'), stemWord('индексация'))
  assert.equal(stemWordLoose('памяти'), stemWordLoose('память'))
  assert.ok(stemVariantsInclude('память', 'памят'))
  assert.deepEqual(stemTokens('индексатора'), [...new Set([...(stemTokens('индексатор')), ...stemTokens('индексатора')])].filter((token) => stemTokens('индексатор').includes(token)))
  assert.ok(stemText('Индексатор обходит файлы').includes('индексатор'))
})

/** Есть ли в вариантах слова ожидаемая основа. */
function stemVariantsInclude(word, expected) {
  return stemTokens(word).includes(expected)
}

test('лексический поиск находит словоформы, которые чистый unicode61 пропускает', (t) => {
  const store = tempStore(t)
  const { id } = add(store, 'Индексатор', 'Индексатор обходит markdown-файлы воркспейса и режет их на чанки')

  const lexical = searchMemory(store, { query: 'индексаторами' })
  assert.ok(lexical.some((result) => result.id === id), 'словоформа индексаторами не найдена лексическим поиском')

  const raw = searchMemory(store, { query: 'индексаторами' }, { engine: 'unicode61' })
  assert.deepEqual(raw, [], 'unicode61 не должен находить отсутствующую словоформу')
})

test('trigram-fallback переживает опечатку', (t) => {
  const store = tempStore(t)
  const { id } = add(store, 'Индексатор', 'Индексатор обходит markdown-файлы и режет их на чанки')

  assert.ok(trigramSimilarity('индексаторр', 'Индексатор обходит markdown-файлы') > 0.4)
  const typo = searchMemory(store, { query: 'индексаторр' })
  assert.ok(typo.some((result) => result.id === id), 'опечатка не пережита')

  const raw = searchMemory(store, { query: 'индексаторр' }, { engine: 'unicode61' })
  assert.deepEqual(raw, [])
  assert.ok(buildTrigramMatch('индексаторр').includes('инд'))
})

test('синонимы расширяют запрос и выключаются флагом/конфигом', (t) => {
  const store = tempStore(t)
  const { id } = add(store, 'Хранилище', 'Хранилище проекта живёт в SQLite')

  // «память» в тексте нет, но словарь знает синоним «хранилище».
  const expanded = searchMemory(store, { query: 'память' })
  assert.ok(expanded.some((result) => result.id === id), 'синоним хранилище не сработал')

  const off = searchMemory(store, { query: 'память' }, { synonyms: false })
  assert.deepEqual(off, [], 'при synonyms:false расширение не должно применяться')

  // Синонимы не должны подменять прямое совпадение: прямое слово находится.
  assert.ok(searchMemory(store, { query: 'хранилище' }).some((result) => result.id === id))
  assert.ok(buildLexMatch('память', { synonyms: true }).includes('хранилищ'))
})

test('verified Q&A ищется отдельным каналом по заголовку и идёт выше обычных сниппетов', (t) => {
  const store = tempStore(t)
  const doc = add(store, 'Провенанс', 'Провенанс записи состоит из source_path и source_ref')
  const answer = add(store, 'Что такое провенанс', 'Источник записи и автор', { kind: 'answer' })
  const draftAnswer = add(store, 'Что такое провенанс (черновик)', 'Провенанс черновой', { kind: 'answer', status: 'draft' })

  const results = searchMemory(store, { query: 'провенанс' })
  assert.equal(results[0].id, answer.id, 'verified Q&A должен быть первым')
  // Кириллица в SQLite lower() не складывается — канал обязан сравнивать в JS.
  for (const query of ['Что такое провенанс', 'что такое провенанс', 'ЧТО ТАКОЕ ПРОВЕНАНС']) {
    assert.equal(searchMemory(store, { query })[0]?.id, answer.id, `регистр запроса ${query}`)
  }
  // Чистый unicode61 не должен пользоваться Q&A-каналом: иначе сравнение движков нечестное.
  // unicode61 может найти answer обычным MATCH по заголовку, но не должен
  // получать Q&A-boost (синтетический score -1e9).
  const raw = searchMemory(store, { query: 'провенанс', k: 5 }, { engine: 'unicode61' })
  assert.ok(raw.every((row) => row.score > -1e6), 'unicode61 не должен подмешивать Q&A-канал')
  assert.ok(!results.some((result) => result.id === draftAnswer.id), 'draft Q&A не должен попадать в канал')
  assert.ok(results.some((result) => result.id === doc.id), 'обычный сниппет должен остаться в выдаче')

  // Q&A-канал работает только для status:verified; при status:all оба ответа
  // видны обычным каналом, без буста.
  const withDrafts = searchMemory(store, { query: 'провенанс', status: 'all' })
  assert.ok(withDrafts.some((result) => result.id === answer.id), 'verified answer виден')
  assert.ok(withDrafts.some((result) => result.id === draftAnswer.id), 'draft виден при status:all')
})

test('бенчмарк 015 сравнивает лексический движок с чистым unicode61', () => {
  const comparison = compareBenchmark()
  assert.equal(comparison.lexical.engine, 'lexical')
  assert.equal(comparison.unicode61.engine, 'unicode61')
  assert.equal(comparison.lexical.questions, 20)
  assert.equal(comparison.unicode61.questions, 20)
  assert.equal(comparison.lexical.passed, true)
  assert.equal(comparison.unicode61.passed, true)
})

test('backfill лексических колонок при открытии: старые записи становятся искомыми', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-lex-backfill-'))
  const store = openStore({ dbPath: dir, namespace: 'demo' })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  // Имитация записи «до миграции 3»: лексические колонки пусты, hash заполнен.
  store.database.prepare(`
    INSERT INTO entries (namespace, kind, title, text, status, confidence, created_at, updated_at, hash)
    VALUES ('demo', 'doc', 'Индексатор', 'Индексатор обходит файлы', 'verified', 1, 1, 1, 'legacy-hash')
  `).run()
  assert.equal(store.database.prepare("SELECT title_lex FROM entries WHERE hash = 'legacy-hash'").get().title_lex, '')
  store.close()

  const reopened = openStore({ dbPath: dir, namespace: 'demo' })
  t.after(() => reopened.close())
  assert.notEqual(reopened.database.prepare("SELECT title_lex FROM entries WHERE hash = 'legacy-hash'").get().title_lex, '')
  assert.equal(searchMemory(reopened, { query: 'индексатором' }).length, 1)
})

test('инъекция уважает выключатель синонимов', async (t) => {
  const { buildMemoryBlock } = await import('../lib/inject.js')
  const store = tempStore(t)
  add(store, 'Хранилище', 'Хранилище проекта живёт в SQLite')

  const withSynonyms = buildMemoryBlock(store, 'память', { env: {} })
  assert.ok(withSynonyms.block !== null, 'синоним хранилище должен найти запись')
  const without = buildMemoryBlock(store, 'память', { env: {}, synonyms: false })
  assert.equal(without.block, null, 'synonyms:false должен выключить расширение')
})
