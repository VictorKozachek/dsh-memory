/**
 * Тесты индексации решений и доски (задача 014): карточки `.kanban/tasks/*.md`
 * и `docs/adr/*` индексируются как `decision` (TTL 180 дней), README
 * компонентов — как `doc`; изменение/удаление файла переводит его чанки в
 * `stale`, поэтому старый текст перестаёт выдаваться поиском.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { indexWorkspace, kindForPath } from '../lib/indexer.js'
import { searchMemory } from '../lib/search.js'
import { openStore } from '../lib/store.js'

const DAY = 24 * 60 * 60 * 1_000
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0)

const CARD = `# Задача 013

## Решение

Карточка доски хранит решение о верификации записей.
`

const ADR = `# ADR 0001

## Контекст

Решение использовать SQLite FTS5 для поиска по памяти.
`

const COMPONENT = `# Компонент памяти

## Использование

Компонентный README описывает API памяти.
`

/** Временный каталог воркспейса; удаляется после теста. */
function tempDir(t, prefix = 'dsh-memory-board-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Записать файл, создав каталоги. */
function writeFile(root, path, content) {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

/** Открыть хранилище на временном каталоге; закрывается после теста. */
function tempStore(t, namespace = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-board-db-'))
  const store = openStore({ dbPath: dir, namespace, now: () => NOW })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

/** Воркспейс: карточка доски, ADR, README компонента и корневой README. */
function buildWorkspace(t) {
  const root = tempDir(t)
  writeFile(root, '.kanban/tasks/013.md', CARD)
  writeFile(root, 'docs/adr/0001-memory.md', ADR)
  writeFile(root, 'packages/memory/README.md', COMPONENT)
  writeFile(root, 'README.md', '# dsh-memory\n\n## Обзор\n\nКорневой README проекта.\n')
  return root
}

test('kindForPath: доска и ADR — decision, README — doc', () => {
  assert.equal(kindForPath('.kanban/tasks/013.md'), 'decision')
  assert.equal(kindForPath('docs/adr/0001-memory.md'), 'decision')
  assert.equal(kindForPath('README.md'), 'doc')
  assert.equal(kindForPath('packages/memory/README.md'), 'doc')
  assert.equal(kindForPath('docs/adr/nested/notes.md'), 'doc')
})

test('индексируются доска, ADR и README компонентов с правильными kind', (t) => {
  const root = buildWorkspace(t)
  const store = tempStore(t)
  const summary = indexWorkspace({ workspace: root, store, now: () => NOW })

  assert.equal(summary.indexed, 4)
  assert.deepEqual(summary.removed, [])
  const rows = store.database
    .prepare("SELECT source_path, kind FROM entries WHERE status = 'verified' ORDER BY source_path")
    .all()
    .map((row) => ({ ...row }))
  assert.deepEqual(rows, [
    { source_path: '.kanban/tasks/013.md', kind: 'decision' },
    { source_path: 'README.md', kind: 'doc' },
    { source_path: 'docs/adr/0001-memory.md', kind: 'decision' },
    { source_path: 'packages/memory/README.md', kind: 'doc' },
  ])

  assert.equal(searchMemory(store, { query: 'верификации' }, { now: () => NOW }).length, 1)
  assert.equal(searchMemory(store, { query: 'SQLite FTS5' }, { now: () => NOW }).length, 1)
  assert.equal(searchMemory(store, { query: 'API памяти' }, { now: () => NOW }).length, 1)
})

test('TTL применяется к decision: карточка/ADR живут 180 дней, doc — бессрочно', (t) => {
  const root = buildWorkspace(t)
  const store = tempStore(t)
  indexWorkspace({ workspace: root, store, now: () => NOW })

  const at179 = NOW + 179 * DAY
  assert.equal(searchMemory(store, { query: 'верификации' }, { now: () => at179 }).length, 1)
  assert.equal(searchMemory(store, { query: 'SQLite FTS5' }, { now: () => at179 }).length, 1)

  const at181 = NOW + 181 * DAY
  assert.deepEqual(searchMemory(store, { query: 'верификации' }, { now: () => at181 }), [])
  assert.deepEqual(searchMemory(store, { query: 'SQLite FTS5' }, { now: () => at181 }), [])
  assert.equal(searchMemory(store, { query: 'Корневой README' }, { now: () => at181 }).length, 1, 'doc не протухает')
})

test('изменённый файл: старые чанки stale, новый текст находится', (t) => {
  const root = buildWorkspace(t)
  const store = tempStore(t)
  indexWorkspace({ workspace: root, store, now: () => NOW })

  writeFile(root, '.kanban/tasks/013.md', `# Задача 013\n\n## Решение\n\nОбновлённое решение о проверке источника.\n`)
  const summary = indexWorkspace({ workspace: root, store, now: () => NOW + 1_000 })
  assert.equal(summary.indexed, 1)
  assert.ok(summary.stale >= 1)

  const stale = store.database
    .prepare("SELECT title, text FROM entries WHERE source_path = ? AND status = 'stale'")
    .all('.kanban/tasks/013.md')
  assert.ok(stale.some((row) => row.text.includes('верификации записей')), 'старый чанк должен остаться как stale')
  assert.deepEqual(searchMemory(store, { query: 'верификации' }, { now: () => NOW + 1_000 }), [])
  assert.equal(searchMemory(store, { query: 'проверке источника' }, { now: () => NOW + 1_000 }).length, 1)
})

test('удалённый файл: чанки stale, источник удалён, запись не выдаётся', (t) => {
  const root = buildWorkspace(t)
  const store = tempStore(t)
  indexWorkspace({ workspace: root, store, now: () => NOW })
  assert.ok(store.getSource('.kanban/tasks/013.md'))

  rmSync(join(root, '.kanban/tasks/013.md'))
  const summary = indexWorkspace({ workspace: root, store, now: () => NOW + 1_000 })
  assert.deepEqual(summary.removed, ['.kanban/tasks/013.md'])
  assert.deepEqual(searchMemory(store, { query: 'верификации' }, { now: () => NOW + 1_000 }), [])
  assert.equal(store.getSource('.kanban/tasks/013.md'), null)
  const stale = store.database
    .prepare("SELECT status FROM entries WHERE source_path = ?")
    .all('.kanban/tasks/013.md')
  assert.ok(stale.length > 0)
  assert.ok(stale.every((row) => row.status === 'stale'))
})
