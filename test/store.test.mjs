/**
 * Тесты хранилища: открытие по пути из конфига, WAL, идемпотентные миграции,
 * схема, вставка/выборка, FTS5 с синхронизацией триггерами, изоляция namespace
 * и повторное открытие.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SCHEMA_VERSION, databaseFile, entryHash, openStore } from '../lib/store.js'

/** Временный каталог на тест; удаляется после него. */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Открыть хранилище на временном каталоге и закрыть после теста. */
function openTempStore(t, namespace = 'demo') {
  const dir = tempDir(t)
  const store = openStore({ dbPath: dir, namespace, now: () => 1_000 })
  t.after(() => store.close())
  return { dir, store }
}

test('открывает БД по пути из конфига и включает WAL', (t) => {
  const { dir, store } = openTempStore(t)

  assert.equal(store.namespace, 'demo')
  assert.equal(store.file, databaseFile(dir, 'demo'))
  assert.ok(existsSync(store.file), 'файл БД не создан')
  assert.equal(store.database.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  assert.equal(store.database.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)
})

test('схема содержит sources, entries, entries_fts, metrics и уникальный hash', (t) => {
  const { store } = openTempStore(t)

  const tables = store.database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name)
  for (const table of ['sources', 'entries', 'entries_fts', 'metrics']) {
    assert.ok(tables.includes(table), `нет таблицы ${table}`)
  }

  const columns = store.database.prepare('PRAGMA table_info(entries)').all().map((column) => column.name)
  for (const column of ['namespace', 'kind', 'title', 'text', 'status', 'confidence', 'source_path', 'source_ref', 'author', 'created_at', 'updated_at', 'hash']) {
    assert.ok(columns.includes(column), `нет колонки entries.${column}`)
  }

  const uniqueIndexes = store.database
    .prepare('PRAGMA index_list(entries)')
    .all()
    .filter((index) => index.unique === 1)
  const hashIndexed = uniqueIndexes.some((index) =>
    store.database.prepare(`PRAGMA index_info("${index.name}")`).all().some((column) => column.name === 'hash'))
  assert.ok(hashIndexed, 'hash должен быть уникальным')

  const triggers = store.database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'entries' ORDER BY name")
    .all()
    .map((row) => row.name)
  assert.deepEqual(triggers, ['entries_fts_delete', 'entries_fts_insert', 'entries_fts_update'])
})

test('вставка и выборка записи по id и по хэшу', (t) => {
  const { store } = openTempStore(t)

  const { id, hash } = store.insertEntry({
    kind: 'fact',
    title: 'Хранилище',
    text: 'Память проекта живёт в SQLite',
    sourcePath: 'docs/storage.md',
    sourceRef: 'task/002',
    author: 'session-1',
    confidence: 0.8,
  })
  const expectedHash = entryHash('fact', 'Хранилище', 'Память проекта живёт в SQLite')
  assert.equal(hash, expectedHash)

  const entry = store.getEntry(id)
  assert.equal(entry.id, id)
  assert.equal(entry.namespace, 'demo')
  assert.equal(entry.title, 'Хранилище')
  assert.equal(entry.status, 'draft')
  assert.equal(entry.confidence, 0.8)
  assert.equal(entry.source_path, 'docs/storage.md')
  assert.equal(entry.source_ref, 'task/002')
  assert.equal(entry.author, 'session-1')
  assert.equal(entry.created_at, 1_000)
  assert.equal(entry.updated_at, 1_000)

  assert.equal(store.findEntryByHash(hash).id, id)
  assert.equal(store.findEntryByHash(entryHash('fact', 'нет', 'такой')), null)
})

test('дубликат по hash не вставляется', (t) => {
  const { store } = openTempStore(t)
  const entry = { kind: 'fact', title: 'Дубль', text: 'одна и та же запись' }

  store.insertEntry(entry)
  assert.throws(() => store.insertEntry(entry), /UNIQUE constraint failed: entries\.hash/)
})

test('FTS5 находит запись и синхронизируется с entries', (t) => {
  const { store } = openTempStore(t)
  const { id } = store.insertEntry({ kind: 'doc', title: 'Память проекта', text: 'долгосрочная память на sqlite' })

  const found = store.searchEntries('sqlite')
  assert.equal(found.length, 1)
  assert.equal(found[0].id, id)
  assert.ok(found[0].score <= 0, 'bm25 должен быть неположительным')

  // UPDATE и DELETE идут мимо методов хранилища — работают триггеры FTS5.
  store.database.prepare('UPDATE entries SET text = ? WHERE id = ?').run('долгосрочная память на postgres', id)
  assert.equal(store.searchEntries('sqlite').length, 0)
  assert.equal(store.searchEntries('postgres').length, 1)

  store.database.prepare('DELETE FROM entries WHERE id = ?').run(id)
  assert.equal(store.searchEntries('postgres').length, 0)
  assert.equal(store.getEntry(id), null)
})

test('пустой и невалидный запрос дают пустой массив, а не исключение', (t) => {
  const { store } = openTempStore(t)
  store.insertEntry({ kind: 'fact', title: 'Строка', text: 'текст для поиска' })

  assert.deepEqual(store.searchEntries(''), [])
  assert.deepEqual(store.searchEntries('   '), [])
  assert.deepEqual(store.searchEntries('текст ИЛИ ('), [])
})

test('namespace изолирует запись, выборку и поиск', (t) => {
  const dir = tempDir(t)
  assert.notEqual(databaseFile(dir, 'alpha'), databaseFile(dir, 'beta'), 'у namespace должен быть свой файл')
  const store = openStore({ dbPath: dir, namespace: 'alpha' })
  t.after(() => store.close())

  const own = store.insertEntry({ kind: 'fact', title: 'Альфа', text: 'секрет альфы' })
  // Чужая запись в том же файле — как если бы БД открыли под другим namespace.
  // Пишем мимо API: снаружи такие строки может оставить CLI или будущая общая БД.
  const foreignHash = entryHash('fact', 'Бета', 'секрет беты')
  const foreignId = Number(store.database
    .prepare(`
      INSERT INTO entries (namespace, kind, title, text, status, confidence, created_at, updated_at, hash)
      VALUES ('beta', 'fact', 'Бета', 'секрет беты', 'draft', 0, 1, 1, ?)
    `)
    .run(foreignHash).lastInsertRowid)

  // Строка чужая, но FTS-триггер её проиндексировал — фильтр namespace обязателен.
  assert.equal(store.database.prepare('SELECT namespace FROM entries WHERE id = ?').get(foreignId).namespace, 'beta')
  assert.equal(store.getEntry(own.id).title, 'Альфа')
  assert.equal(store.database.prepare('SELECT namespace FROM entries WHERE id = ?').get(own.id).namespace, 'alpha')
  assert.equal(store.getEntry(foreignId), null, 'чужая запись видна по id')
  assert.equal(store.findEntryByHash(foreignHash), null, 'чужая запись видна по hash')

  assert.equal(store.searchEntries('альфы').length, 1)
  assert.equal(store.searchEntries('беты').length, 0, 'поиск видит чужой namespace')
})

test('sources обновляется по пути и читается обратно', (t) => {
  const { store } = openTempStore(t)

  store.upsertSource({ path: 'README.md', sha256: 'first', mtime: 10, indexedAt: 20 })
  store.upsertSource({ path: 'README.md', sha256: 'second', mtime: 30, indexedAt: 40 })

  const source = store.getSource('README.md')
  assert.equal(source.sha256, 'second')
  assert.equal(source.mtime, 30)
  assert.equal(source.indexed_at, 40)
  assert.equal(store.getSource('docs/none.md'), null)
})

test('повторное открытие видит данные и не повторяет миграции', (t) => {
  const dir = tempDir(t)
  const file = databaseFile(dir, 'reopen')

  const first = openStore({ dbPath: dir, namespace: 'reopen', now: () => 5_000 })
  const { id } = first.insertEntry({ kind: 'answer', title: 'Вопрос', text: 'ответ, который должен пережить перезапуск' })
  const triggersBefore = first.database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'").get().n
  first.close()

  const second = openStore({ dbPath: dir, namespace: 'reopen' })
  t.after(() => second.close())

  assert.equal(second.file, file)
  assert.equal(second.getEntry(id).text, 'ответ, который должен пережить перезапуск')
  assert.equal(second.database.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)
  const triggersAfter = second.database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'").get().n
  assert.equal(triggersAfter, triggersBefore, 'миграция применилась повторно')

  second.close()
  assert.doesNotThrow(() => second.close(), 'повторное закрытие должно быть безопасным')
})

test('databaseFile раскрывает ~ и не выпускает путь за каталог', () => {
  assert.equal(databaseFile('/base', 'dsh-memory'), '/base/dsh-memory.db')
  assert.equal(databaseFile('~/.dsh/memory', 'ws'), join(homedir(), '.dsh/memory/ws.db'))
  assert.equal(databaseFile('/base', 'a/b'), '/base/a_b.db')
  assert.equal(databaseFile('/base', '../evil'), '/base/__evil.db')
  assert.throws(() => databaseFile('/base', '   '), /namespace/)
  assert.throws(() => databaseFile('   ', 'ws'), /dbPath/)
})

test('openStore создаёт каталог БД, даже если его не было', (t) => {
  const dir = tempDir(t)
  const nested = join(dir, 'nested', 'memory')
  const store = openStore({ dbPath: nested, namespace: 'ws' })
  t.after(() => store.close())

  assert.equal(store.file, join(nested, 'ws.db'))
  assert.ok(existsSync(nested))
  assert.ok(existsSync(store.file))
})
