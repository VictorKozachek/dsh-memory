/**
 * Тесты автоиндексации первого хода (задача 036): фон, off-флаги, инкремент,
 * исключения, ошибки и e2e «после автoиндексации память находит README/AGENTS».
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createAutoindexScheduler, autoindexEnabled } from '../lib/autoindex.js'
import { registerMemoryInjection } from '../lib/hook.js'
import { indexWorkspace, walkMarkdown } from '../lib/indexer.js'
import { searchMemory } from '../lib/search.js'
import { openStore } from '../lib/store.js'

/** Временный каталог. */
function tempDir(t, prefix = 'dsh-memory-autoindex-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Store с countEntries. */
function fakeStore(count = 0) {
  return { countEntries: () => count }
}

/** Создать планировщик с очередью. */
function schedulerWithQueue(indexer, logs = []) {
  const queue = []
  const scheduler = createAutoindexScheduler({
    indexer,
    schedule: (callback) => queue.push(callback),
    logger: (level, message) => logs.push(`${level}:${message}`),
  })
  return { scheduler, queue, logs }
}

test('пустой индекс: планирует фон, не блокирует, пишет прогресс', () => {
  const calls = []
  const { scheduler, queue, logs } = schedulerWithQueue((input) => {
    calls.push(input)
    return { files: 2, indexed: 2, unchanged: 0 }
  })
  assert.equal(scheduler.maybeSchedule({ store: fakeStore(0), workspace: '/tmp/ws', config: { index: { autoindex: true } }, env: {} }), true)
  assert.equal(calls.length, 0, 'индексация не должна идти синхронно')
  assert.equal(queue.length, 1)
  queue[0]()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].workspace, '/tmp/ws')
  assert.ok(logs.some((line) => line.includes('проиндексировано 2, без изменений 0')))
})

test('непустой индекс не планирует; off-флаги отключают', () => {
  let calls = 0
  const indexer = () => { calls += 1; return {} }
  const nonEmpty = schedulerWithQueue(indexer)
  assert.equal(nonEmpty.scheduler.maybeSchedule({ store: fakeStore(1), workspace: '/tmp/ws', config: { index: { autoindex: true } }, env: {} }), false)
  const envOff = schedulerWithQueue(indexer)
  assert.equal(envOff.scheduler.maybeSchedule({ store: fakeStore(0), workspace: '/tmp/ws', config: { index: { autoindex: true } }, env: { DSH_MEMORY_AUTOINDEX: 'off' } }), false)
  const configOff = schedulerWithQueue(indexer)
  assert.equal(configOff.scheduler.maybeSchedule({ store: fakeStore(0), workspace: '/tmp/ws', config: { index: { autoindex: false } }, env: {} }), false)
  assert.equal(autoindexEnabled({}, { index: { autoindex: false } }), false)
  assert.equal(autoindexEnabled({ DSH_MEMORY_AUTOINDEX: 'NO' }, {}), false)
})

test('ошибка индексации не бросает; следующий ход снова пытается', () => {
  let attempt = 0
  const { scheduler, queue, logs } = schedulerWithQueue(() => {
    attempt += 1
    if (attempt === 1) throw new Error('indexer down')
    return { files: 1, indexed: 1, unchanged: 0 }
  })
  assert.equal(scheduler.maybeSchedule({ store: fakeStore(0), workspace: '/tmp/ws', config: { index: { autoindex: true } }, env: {} }), true)
  assert.doesNotThrow(() => queue[0]())
  assert.ok(logs.some((line) => line.startsWith('warn:автоиндексация не выполнена')))
  assert.equal(scheduler.maybeSchedule({ store: fakeStore(0), workspace: '/tmp/ws', config: { index: { autoindex: true } }, env: {} }), true)
  queue[1]()
  assert.equal(attempt, 2)
})

test('дефолтные исключения: bench/test/worktrees/benchmark-отчёты не индексируются', (t) => {
  const root = tempDir(t)
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'bench'), { recursive: true })
  mkdirSync(join(root, 'test'), { recursive: true })
  mkdirSync(join(root, 'worktrees'), { recursive: true })
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# README\n\nпамять проекта')
  writeFileSync(join(root, 'docs', 'good.md'), '# Good\n\nполезная документация')
  writeFileSync(join(root, 'docs', 'benchmark-real.md'), '# Benchmark\n\nвопросы бенчмарка')
  writeFileSync(join(root, 'bench', 'q.md'), '# Q\n\nвопрос')
  writeFileSync(join(root, 'test', 't.md'), '# T\n\nтест')
  writeFileSync(join(root, 'worktrees', 'w.md'), '# W\n\nветка')
  writeFileSync(join(root, 'node_modules', 'n.md'), '# N\n\nмодуль')
  const files = walkMarkdown(root)
  assert.deepEqual(files, ['README.md', 'docs/good.md'])
})

test('hook: первый ход планирует индексацию, второй — инкрементально, e2e search находит README/AGENTS', (t) => {
  const workspace = tempDir(t)
  const dbDir = tempDir(t)
  writeFileSync(join(workspace, 'README.md'), '# README\n\nПамять проекта хранится локально в SQLite.')
  writeFileSync(join(workspace, 'AGENTS.md'), '# AGENTS\n\nПравила ролей и задач проекта описаны здесь.')
  const logs = []
  const queue = []
  const hook = registerMemoryInjection({
    on: () => {},
    effect: () => {},
    get: () => undefined,
  }, {
    config: {
      db_path: dbDir,
      namespace: 'demo',
      inject: { enabled: true, top_k: 3, token_budget: 600 },
      search: { snippet_chars: 300 },
      index: { autoindex: true, include: ['**/*.md'], exclude: [], max_chunk_tokens: 800 },
    },
    env: {},
    log: (level, message) => logs.push(`${level}:${message}`),
    autoindexer: createAutoindexScheduler({
      indexer: indexWorkspace,
      schedule: (callback) => queue.push(callback),
      logger: (level, message) => logs.push(`${level}:${message}`),
    }),
  })
  t.after(() => hook?.close())
  const listener = { handler: hook.handler }
  const payload = {
    agent: { session: { header: { cwd: workspace } } },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'как устроена память проекта?' }], source: { kind: 'user' } }],
    step: 1,
    signal: { aborted: false },
  }
  return (async () => {
    await listener.handler(payload, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(queue.length, 1, 'первый ход должен запланировать индексацию')
    queue.shift()()
    const store = openStore({ dbPath: dbDir, namespace: 'demo' })
    t.after(() => store.close())
    assert.ok(searchMemory(store, { query: 'память проекта' }).some((row) => row.source_path === 'README.md'))
    assert.ok(searchMemory(store, { query: 'правила ролей' }).some((row) => row.source_path === 'AGENTS.md'))
    assert.ok(logs.some((line) => line.includes('автоиндексация: проиндексировано')))

    // Второй ход: индекс уже непуст, новых фоновых задач нет.
    await listener.handler(payload, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(queue.length, 0)
  })()
})

test('ошибка после частичной индексации: повтор планируется, несмотря на entries > 0', () => {
  let entries = 0
  let attempt = 0
  const store = { countEntries: () => entries }
  const { scheduler, queue, logs } = schedulerWithQueue(() => {
    attempt += 1
    entries = attempt
    if (attempt === 1) throw new Error('disk full after write')
    return { files: 2, indexed: 2, unchanged: 0 }
  })
  assert.equal(scheduler.maybeSchedule({ store, workspace: '/tmp/ws', config: { index: { autoindex: true } }, env: {} }), true)
  assert.doesNotThrow(() => queue[0]())
  assert.equal(entries, 1)
  assert.ok(logs.some((line) => line.startsWith('warn:автоиндексация не выполнена')))
  // Частичный индекс уже непустой, но failed-state требует retry.
  assert.equal(scheduler.maybeSchedule({ store, workspace: '/tmp/ws', config: { index: { autoindex: true } }, env: {} }), true)
  queue[1]()
  assert.equal(attempt, 2)
  assert.equal(entries, 2)
  assert.equal(scheduler.maybeSchedule({ store, workspace: '/tmp/ws', config: { index: { autoindex: true } }, env: {} }), false)
})
