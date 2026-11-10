/**
 * Регресс-тест апгрейда реальной БД v2 → v3 (задача 020): миграция обязана
 * пройти на существующих записях, не оставить FTS в рассогласованном
 * состоянии и не заблокировать файл. Старая схема v2 восстанавливается из
 * текущей: снимаются объекты миграции 3, колонки удаляются, user_version = 2.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { searchMemory } from '../lib/search.js'
import { openStore } from '../lib/store.js'

/** Версия схемы файла. */
function userVersion(store) {
  return Number(store.database.prepare('PRAGMA user_version').get().user_version)
}

test('БД v2 с записями открывается на v3, записи целы и ищутся по словоформе/опечатке/синониму', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-migration-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  // 1. Создаём БД текущим кодом, записываем данные, затем откатываем схему до v2.
  const created = openStore({ dbPath: dir, namespace: 'n' })
  const { id } = created.insertEntry({
    kind: 'doc',
    title: 'Индексатор',
    text: 'Индексатор обходит воркспейс. Хранилище проекта живёт в SQLite.',
    status: 'verified',
    confidence: 1,
    sourcePath: 'docs/a.md',
  })
  const db = created.database
  for (const trigger of [
    'entries_fts_lex_insert', 'entries_fts_lex_delete', 'entries_fts_lex_update',
    'entries_fts_trigram_insert', 'entries_fts_trigram_delete', 'entries_fts_trigram_update',
  ]) db.exec(`DROP TRIGGER ${trigger}`)
  db.exec('DROP TABLE entries_fts_lex')
  db.exec('DROP TABLE entries_fts_trigram')
  db.exec('ALTER TABLE entries DROP COLUMN title_lex')
  db.exec('ALTER TABLE entries DROP COLUMN text_lex')
  db.exec('PRAGMA user_version = 2')
  created.close()

  // 2. Открываем «старую» БД текущим кодом: миграция 3 должна пройти.
  const upgraded = openStore({ dbPath: dir, namespace: 'n' })
  t.after(() => upgraded.close())
  assert.equal(userVersion(upgraded), 3)
  const entry = upgraded.getEntry(id)
  assert.equal(entry.title, 'Индексатор')
  assert.equal(entry.status, 'verified')
  assert.ok(entry.title_lex.includes('индексатор'), 'backfill должен заполнить title_lex')

  assert.ok(searchMemory(upgraded, { query: 'индексаторами' }).some((row) => row.id === id), 'словоформа не найдена после миграции')
  assert.ok(searchMemory(upgraded, { query: 'индексаторр' }).some((row) => row.id === id), 'опечатка не пережита после миграции')
  assert.ok(searchMemory(upgraded, { query: 'память' }).some((row) => row.id === id), 'синоним не сработал после миграции')

  // 3. Повторное открытие идемпотентно и не портит индекс.
  upgraded.close()
  const reopened = openStore({ dbPath: dir, namespace: 'n' })
  t.after(() => reopened.close())
  assert.equal(userVersion(reopened), 3)
  assert.equal(reopened.getEntry(id).text, entry.text)
  assert.ok(searchMemory(reopened, { query: 'индексаторами' }).some((row) => row.id === id))
})
