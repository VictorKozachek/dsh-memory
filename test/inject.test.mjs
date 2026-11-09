/**
 * Тесты инъекции top-k (задача 010): запрос по первым 200 символам сообщения,
 * ≤ 3 записей и ≤ 600 токенов, формат строки, отсутствие блока без попаданий,
 * отключение через `DSH_MEMORY_INJECT=off`, устойчивость к ошибке поиска и
 * добавка к первому токену ≤ 50 мс.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  INJECT_LINE_PREFIX,
  INJECT_MESSAGE_CHARS,
  INJECT_TOKEN_BUDGET,
  buildMemoryBlock,
  formatMemoryLine,
  injectionEnabled,
} from '../lib/inject.js'
import { estimateTokens } from '../lib/indexer.js'
import { openStore } from '../lib/store.js'

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0)

/** Открыть хранилище на временном каталоге; закрывается после теста. */
function tempStore(t, namespace = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-inject-'))
  const store = openStore({ dbPath: dir, namespace, now: () => NOW })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

/** Вставить verified-запись, которую найдёт поиск. */
function addEntry(store, overrides = {}) {
  return store.insertEntry({
    kind: 'fact',
    title: 'Каскад расхода',
    text: 'каскад L0 L1 L2 L3 — порядок поиска ответа',
    status: 'verified',
    confidence: 1,
    sourcePath: 'docs/cascade.md',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  })
}

test('formatMemoryLine: [memory] title — snippet (source, status)', () => {
  assert.equal(
    formatMemoryLine({ title: 'Память', snippet: 'кратко', source_path: 'docs/a.md', status: 'verified' }),
    `${INJECT_LINE_PREFIX} Память — кратко (docs/a.md, verified)`,
  )
  assert.equal(
    formatMemoryLine({ title: 'Т', snippet: 'S', source_ref: 'task/1', status: 'draft' }),
    `${INJECT_LINE_PREFIX} Т — S (task/1, draft)`,
  )
  assert.equal(
    formatMemoryLine({ title: 'Т', snippet: 'S', status: 'verified' }),
    `${INJECT_LINE_PREFIX} Т — S (memory, verified)`,
  )
})

test('блок: не более top-k записей, формат строк и бюджет 600 токенов', (t) => {
  const store = tempStore(t)
  for (let index = 0; index < 5; index += 1) {
    addEntry(store, {
      title: `Каскад ${index}`,
      text: `каскад L0 L1 L2 L3 порядок поиска ответа, вариант ${index}`,
    })
  }

  const result = buildMemoryBlock(store, 'каскад L0 L1 L2 L3', { env: {} })
  assert.ok(result.block, 'блок не собран')
  const lines = result.block.split('\n')
  assert.equal(lines.length, 3, 'в блок должно попасть не больше трёх записей')
  assert.equal(result.included, 3)
  assert.ok(result.hits >= 3)
  assert.ok(result.tokens <= INJECT_TOKEN_BUDGET)
  assert.equal(estimateTokens(result.block), result.tokens)

  for (const line of lines) {
    assert.match(line, /^\[memory\] .+ — .+ \([^,]+, verified\)$/)
  }
})

test('бюджет: блок не превышает tokenBudget и topK', (t) => {
  const store = tempStore(t)
  const longText = `каскад L0 L1 L2 L3 ${'очень длинный текст '.repeat(20)}`
  for (let index = 0; index < 5; index += 1) {
    addEntry(store, { title: `Длинный ${index}`, text: `${longText} ${index}` })
  }

  const tight = buildMemoryBlock(store, 'каскад L0 L1 L2 L3', { env: {}, tokenBudget: 150 })
  if (tight.block !== null) {
    assert.ok(estimateTokens(tight.block) <= 150, `блок длиннее бюджета: ${tight.tokens}`)
    assert.ok(tight.included <= 1)
  }

  const one = buildMemoryBlock(store, 'каскад L0 L1 L2 L3', { env: {}, topK: 1 })
  assert.ok(one.block)
  assert.equal(one.block.split('\n').length, 1)
})

test('нет попаданий — блока нет и 0 токенов', (t) => {
  const store = tempStore(t)
  addEntry(store)

  for (const message of ['зебра-единорог', '', '   ']) {
    const result = buildMemoryBlock(store, message, { env: {} })
    assert.equal(result.block, null)
    assert.equal(result.tokens, 0)
    assert.equal(result.included, 0)
  }
})

test('DSH_MEMORY_INJECT=off выключает инъекцию', (t) => {
  const store = tempStore(t)
  addEntry(store)

  const disabled = buildMemoryBlock(store, 'каскад L0 L1 L2 L3', { env: { DSH_MEMORY_INJECT: 'off' } })
  assert.equal(disabled.block, null)
  assert.equal(disabled.tokens, 0)
  assert.equal(disabled.hits, 0)

  assert.equal(buildMemoryBlock(store, 'каскад L0 L1 L2 L3', { env: {}, enabled: false }).block, null)
  assert.equal(buildMemoryBlock(store, 'каскад L0 L1 L2 L3', { env: {}, configEnabled: false }).block, null)
})

test('injectionEnabled: off/false/0/no выключают, остальное — включено', () => {
  for (const off of ['off', 'OFF', ' false ', '0', 'no']) {
    assert.equal(injectionEnabled({ DSH_MEMORY_INJECT: off }), false, `значение ${off}`)
  }
  for (const on of [undefined, '', 'on', 'true', '1', 'yes', 'что-то']) {
    assert.equal(injectionEnabled({ DSH_MEMORY_INJECT: on }), true, `значение ${on}`)
  }
  assert.equal(injectionEnabled({}, false), false)
})

test('ошибка поиска не ломает ход: блока просто нет', (t) => {
  const store = tempStore(t)
  addEntry(store)
  store.database.exec('DROP TABLE entries_fts')

  const result = buildMemoryBlock(store, 'каскад L0 L1 L2 L3', { env: {} })
  assert.equal(result.block, null)
  assert.equal(result.tokens, 0)
  assert.match(result.error, /no such table: entries_fts/)
})

test('запрос — ровно первые 200 символов последнего сообщения', () => {
  const seen = []
  const fakeStore = {
    namespace: 'demo',
    searchEntries: (query) => {
      seen.push(query)
      return []
    },
  }

  const late = buildMemoryBlock(fakeStore, `${'слово '.repeat(100)}каскад`, { env: {} })
  assert.equal([...late.query].length, INJECT_MESSAGE_CHARS)
  assert.equal(late.block, null)
  assert.ok(seen[0], 'поиск должен был вызваться')
  assert.ok(!seen[0].includes('каскад'), 'слово за пределами 200 символов не должно попасть в запрос')

  const early = buildMemoryBlock(fakeStore, `каскад ${'слово '.repeat(100)}`, { env: {} })
  assert.ok(seen[1].includes('каскад'), 'слово в первых 200 символах должно попасть в запрос')

  const emoji = buildMemoryBlock(fakeStore, '😀'.repeat(250), { env: {} })
  assert.equal([...emoji.query].length, INJECT_MESSAGE_CHARS)
})

test('добавка к первому токену ≤ 50 мс', (t) => {
  const store = tempStore(t)
  for (let index = 0; index < 30; index += 1) {
    addEntry(store, {
      title: `Каскад ${index}`,
      text: `каскад L0 L1 L2 L3 порядок поиска ответа, запись ${index}`,
    })
  }

  // Первый вызов — разогрев SQLite/подготовки выражений.
  buildMemoryBlock(store, 'каскад L0 L1 L2 L3', { env: {} })
  const measured = buildMemoryBlock(store, 'каскад L0 L1 L2 L3', { env: {} })

  assert.ok(measured.block)
  assert.ok(measured.latencyMs >= 0)
  assert.ok(measured.latencyMs <= 50, `инъекция добавила ${measured.latencyMs} мс`)
})

test('инъекция ищет по любому слову сообщения (matchMode any)', (t) => {
  const store = tempStore(t)
  addEntry(store)

  const result = buildMemoryBlock(store, 'Как устроена память проекта и зачем нужен каскад?', { env: {} })
  assert.ok(result.block, 'частичное совпадение слов не должно давать пустой блок')
  assert.match(result.block, /^\[memory\] /)
})
