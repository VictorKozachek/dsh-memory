/**
 * Тесты `memory.write`: вставка `draft` с хэшем, дедупликация с повышением
 * confidence и объединением провенанса, правило «без источника — < 0.5» и
 * запрет писать `verified` напрямую.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SCHEMA_VERSION, entryHash, openStore } from '../lib/store.js'
import { ENTRY_KINDS, writeMemory } from '../lib/write.js'

/** Открыть хранилище на временном каталоге; закрывается после теста. */
function tempStore(t, namespace = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-write-'))
  const store = openStore({ dbPath: dir, namespace, now: () => 1_000 })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

/** Валидный вход memory.write с переопределениями. */
function input(overrides = {}) {
  return { kind: 'fact', title: 'Заголовок', text: 'Текст знания', ...overrides }
}

test('memory.write вставляет draft с hash = sha256(kind|title|text) и провенансом', (t) => {
  const store = tempStore(t)
  const result = writeMemory(store, input({
    title: 'FTS5',
    text: 'Поиск по памяти идёт через FTS5',
    sources: [{ path: 'README.md', ref: 'task/001' }],
    author: 'session-1',
  }), { now: () => 1_000 })

  assert.equal(typeof result.id, 'number')
  assert.equal(result.deduped, false)
  assert.equal(result.status, 'draft')

  const entry = store.getEntry(result.id)
  assert.equal(entry.hash, entryHash('fact', 'FTS5', 'Поиск по памяти идёт через FTS5'))
  assert.equal(entry.kind, 'fact')
  assert.equal(entry.status, 'draft')
  assert.equal(entry.confidence, 0.5)
  assert.equal(entry.source_path, 'README.md')
  assert.equal(entry.source_ref, 'task/001')
  assert.equal(entry.author, 'session-1')
  assert.equal(entry.created_at, 1_000)
  assert.equal(entry.updated_at, 1_000)
  assert.deepEqual(store.listEntrySources(result.id), [{ path: 'README.md', ref: 'task/001' }])
})

test('memory.write не пишет verified или stale напрямую', (t) => {
  const store = tempStore(t)

  for (const status of ['verified', 'stale']) {
    assert.throws(() => writeMemory(store, input({ status })), /пишет только "draft"/)
  }
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM entries').get().n, 0)
})

test('дедупликация по hash повышает confidence и объединяет источники', (t) => {
  const store = tempStore(t)

  const first = writeMemory(store, input({
    kind: 'answer',
    title: 'Вопрос',
    text: 'Ответ',
    sources: [{ ref: 'task/001' }],
    confidence: 0.4,
  }), { now: () => 1_000 })
  const before = store.getEntry(first.id)
  assert.equal(before.confidence, 0.4)

  const second = writeMemory(store, input({
    kind: 'answer',
    title: 'Вопрос',
    text: 'Ответ',
    sources: [{ path: 'docs/db.md' }, { ref: 'commit:abc' }],
    confidence: 0.4,
  }), { now: () => 2_000 })

  assert.equal(second.id, first.id)
  assert.equal(second.deduped, true)
  assert.equal(second.status, 'draft')

  const after = store.getEntry(first.id)
  assert.equal(after.confidence, 0.5, 'дубль должен повысить confidence')
  assert.ok(after.confidence > before.confidence)
  // Основной источник не перезаписывается, но пустые поля заполняются.
  assert.equal(after.source_ref, 'task/001')
  assert.equal(after.source_path, 'docs/db.md')
  assert.equal(after.updated_at, 2_000)
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM entries').get().n, 1, 'дубль не создал новую запись')

  assert.deepEqual(store.listEntrySources(first.id), [
    { path: null, ref: 'commit:abc' },
    { path: null, ref: 'task/001' },
    { path: 'docs/db.md', ref: null },
  ])
})

test('повторный дубль без источников поднимает confidence на шаг', (t) => {
  const store = tempStore(t)
  const entry = input({ title: 'Черновик', text: 'Наблюдение' })

  const first = writeMemory(store, entry, { now: () => 1_000 })
  assert.equal(store.getEntry(first.id).confidence, 0.3)

  const second = writeMemory(store, entry, { now: () => 2_000 })
  assert.equal(second.id, first.id)
  assert.equal(second.deduped, true)
  assert.equal(store.getEntry(first.id).confidence, 0.4)
})

test('без источника — только draft и confidence < 0.5', (t) => {
  const store = tempStore(t)

  const result = writeMemory(store, input({ title: 'Без источника', text: 'Наблюдение' }))
  assert.equal(store.getEntry(result.id).confidence, 0.3)
  assert.equal(store.getEntry(result.id).source_path, null)
  assert.equal(store.getEntry(result.id).source_ref, null)
  assert.deepEqual(store.listEntrySources(result.id), [])

  assert.throws(
    () => writeMemory(store, input({ title: 'Порог', text: 'Наблюдение', confidence: 0.5 })),
    /без источника.*confidence < 0\.5/,
  )
  assert.throws(
    () => writeMemory(store, input({ title: 'Высоко', text: 'Наблюдение', confidence: 0.9 })),
    /без источника/,
  )

  // 0.49 — ещё допустимо.
  const low = writeMemory(store, input({ title: 'Почти', text: 'Наблюдение', confidence: 0.49 }))
  assert.equal(store.getEntry(low.id).confidence, 0.49)
})

test('с источником confidence берётся из входа, дефолт — 0.5', (t) => {
  const store = tempStore(t)

  const custom = writeMemory(store, input({ title: 'Свой', text: 'С источником', sources: [{ path: 'a.md' }], confidence: 0.2 }))
  assert.equal(store.getEntry(custom.id).confidence, 0.2)

  const fallback = writeMemory(store, input({ title: 'Дефолт', text: 'С источником', sources: [{ ref: 'task/005' }] }))
  assert.equal(store.getEntry(fallback.id).confidence, 0.5)
  assert.equal(store.getEntry(fallback.id).source_ref, 'task/005')
})

test('разное содержимое даёт разные записи', (t) => {
  const store = tempStore(t)
  const a = writeMemory(store, input({ title: 'Один', text: 'Текст' }))
  const b = writeMemory(store, input({ title: 'Другой', text: 'Текст' }))

  assert.notEqual(a.id, b.id)
  assert.equal(a.deduped, false)
  assert.equal(b.deduped, false)
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM entries').get().n, 2)
})

test('невалидный вход отклоняется с понятной ошибкой', (t) => {
  const store = tempStore(t)

  assert.throws(() => writeMemory(store, null), /объект/)
  assert.throws(() => writeMemory(store, input({ kind: 'unknown-kind' })), /kind/)
  assert.throws(() => writeMemory(store, input({ title: '   ' })), /title/)
  assert.throws(() => writeMemory(store, input({ text: '' })), /text/)
  assert.throws(() => writeMemory(store, input({ sources: { path: 'a.md' } })), /sources должен быть массивом/)
  assert.throws(() => writeMemory(store, input({ sources: [{ path: '' }] })), /sources\[0\]\.path/)
  assert.throws(() => writeMemory(store, input({ sources: [{}] })), /path или ref/)
  assert.throws(() => writeMemory(store, input({ sources: [{ path: 'a.md' }], confidence: 1.5 })), /confidence/)
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM entries').get().n, 0)
})

test('схема v2: таблица entry_sources живёт вместе с записями', (t) => {
  const store = tempStore(t)

  assert.equal(store.database.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)
  const tables = store.database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name)
  assert.ok(tables.includes('entry_sources'))
  assert.deepEqual(ENTRY_KINDS, ['doc', 'decision', 'fact', 'answer', 'code-note'])

  // Удаление записи чистит и её провенанс (PRAGMA foreign_keys + CASCADE).
  const { id } = writeMemory(store, input({ title: 'С источником', text: 'Текст', sources: [{ path: 'a.md' }] }))
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM entry_sources').get().n, 1)
  store.database.prepare('DELETE FROM entries WHERE id = ?').run(id)
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM entry_sources').get().n, 0)
})
