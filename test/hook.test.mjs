/**
 * Тесты per-turn хука инъекции (задача 010): регистрация `agent/pre-step`,
 * добавление блока в сообщения шага, отключение, ошибки и очистка.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PRE_STEP_EVENT, createPluginMessage, lastUserMessageFromSession, registerMemoryInjection } from '../lib/hook.js'
import * as plugin from '../lib/index.js'
import { openStore } from '../lib/store.js'

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0)

/** Мок cordis-контекста: запоминает слушателей и эффекты. */
function mockContext() {
  const listeners = []
  const effects = []
  return {
    listeners,
    effects,
    on(event, handler, options) {
      listeners.push({ event, handler, options })
      return () => {}
    },
    effect(callback) {
      effects.push(callback)
      return () => {}
    },
  }
}

/** Мок агента с cwd сессии и логом событий. */
function mockAgent({ cwd = tmpdir(), events = [] } = {}) {
  return { session: { header: { cwd }, events } }
}

/** Human user-message. */
function userMessage(text, source = { kind: 'user' }) {
  return { id: `m-${Math.random()}`, role: 'user', content: [{ type: 'text', text }], source }
}

/** Заполнить хранилище в каталоге и закрыть его (хук откроет своё). */
function seedStore(dbDir, namespace, entries) {
  const store = openStore({ dbPath: dbDir, namespace, now: () => NOW })
  for (const entry of entries) {
    store.insertEntry({
      kind: 'fact',
      title: 'Память проекта',
      text: 'память проекта — долговременное хранилище знаний',
      status: 'verified',
      confidence: 1,
      sourcePath: 'docs/memory.md',
      createdAt: NOW,
      updatedAt: NOW,
      ...entry,
    })
  }
  store.close()
}

/** Каталог на тест. */
function tempDir(t, prefix = 'dsh-memory-hook-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Зарегистрировать хук на мок-контексте. */
function setupHook(t, { entries = [{}], config = {}, env = {} } = {}) {
  const dbDir = tempDir(t)
  const namespace = 'demo'
  seedStore(dbDir, namespace, entries)
  const ctx = mockContext()
  const hook = registerMemoryInjection(ctx, {
    config: {
      db_path: dbDir,
      namespace,
      inject: { enabled: true, top_k: 3, token_budget: 600 },
      search: { snippet_chars: 300 },
      ...config,
    },
    env,
  })
  t.after(() => hook?.close())
  const listener = ctx.listeners.find((item) => item.event === PRE_STEP_EVENT)
  return { ctx, hook, listener, dbDir, namespace }
}

/** Вызвать слушатель хука. */
async function runHook(listener, payload, decision = { kind: 'enter', messages: [] }) {
  return listener.handler(payload, async () => decision)
}

test('apply регистрирует agent/pre-step с prepend и объявляет inject agents', () => {
  const ctx = mockContext()
  plugin.apply(ctx, { db_path: tmpdir(), namespace: 'demo' })

  assert.ok(plugin.inject.includes('agents'))
  const listener = ctx.listeners.find((item) => item.event === PRE_STEP_EVENT)
  assert.ok(listener, 'слушатель agent/pre-step не зарегистрирован')
  assert.deepEqual(listener.options, { prepend: true })
  assert.equal(typeof listener.handler, 'function')
})

test('хук добавляет блок памяти в сообщения шага на первом ходе', async (t) => {
  const { listener, dbDir } = setupHook(t)

  const decision = await runHook(listener, {
    agent: mockAgent({ cwd: dbDir }),
    messages: [userMessage('Как устроена память проекта и зачем она нужна?')],
    turn: 1,
    step: 1,
    signal: { aborted: false },
  })

  assert.equal(decision.messages.length, 1)
  const injected = decision.messages[0]
  assert.equal(injected.role, 'user')
  assert.equal(injected.source.kind, 'plugin')
  assert.equal(injected.source.plugin, 'dsh-memory')
  assert.equal(injected.source.form, 'snapshot')
  assert.match(injected.content[0].text, /^\[memory\] .+ — .+ \(docs\/memory\.md, verified\)/m)
})

test('нет попаданий — сообщения не меняются', async (t) => {
  const { listener, dbDir } = setupHook(t)

  const decision = await runHook(listener, {
    agent: mockAgent({ cwd: dbDir }),
    messages: [userMessage('совершенно посторонний запрос про пингвинов')],
    turn: 1,
    step: 1,
    signal: { aborted: false },
  })

  assert.deepEqual(decision.messages, [])
})

test('DSH_MEMORY_INJECT=off и inject.enabled=false отключают хук', async (t) => {
  const off = setupHook(t, { env: { DSH_MEMORY_INJECT: 'off' } })
  const first = await runHook(off.listener, {
    agent: mockAgent({ cwd: off.dbDir }),
    messages: [userMessage('память проекта')],
    turn: 1,
    step: 1,
    signal: { aborted: false },
  })
  assert.deepEqual(first.messages, [])

  const disabled = setupHook(t, { config: { inject: { enabled: false, top_k: 3, token_budget: 600 } } })
  const second = await runHook(disabled.listener, {
    agent: mockAgent({ cwd: disabled.dbDir }),
    messages: [userMessage('память проекта')],
    turn: 1,
    step: 1,
    signal: { aborted: false },
  })
  assert.deepEqual(second.messages, [])
})

test('reject от next() не трогается', async (t) => {
  const { listener, dbDir } = setupHook(t)

  const decision = await runHook(listener, {
    agent: mockAgent({ cwd: dbDir }),
    messages: [userMessage('память проекта')],
    turn: 1,
    step: 1,
    signal: { aborted: false },
  }, { kind: 'reject' })

  assert.deepEqual(decision, { kind: 'reject' })
})

test('на следующих шагах без нового сообщения инъекции нет; fallback — лог сессии', async (t) => {
  const { listener, dbDir } = setupHook(t)
  const agent = mockAgent({
    cwd: dbDir,
    events: [{ type: 'user/message', data: userMessage('память проекта') }],
  })

  // step 2, сообщений шага нет — память уже вставлялась на первом шаге.
  const later = await runHook(listener, { agent, messages: [], turn: 1, step: 2, signal: { aborted: false } })
  assert.deepEqual(later.messages, [])

  // step 1 без claimed-сообщений — берём последнее user/message из лога сессии.
  const first = await runHook(listener, { agent, messages: [], turn: 2, step: 1, signal: { aborted: false } })
  assert.equal(first.messages.length, 1)
  assert.match(first.messages[0].content[0].text, /^\[memory\] /)
})

test('ошибка открытия хранилища не ломает ход', async (t) => {
  const dir = tempDir(t)
  const notADir = join(dir, 'file')
  writeFileSync(notADir, 'x')
  const ctx = mockContext()
  const warnings = []
  const hook = registerMemoryInjection(ctx, {
    config: { db_path: notADir, namespace: 'demo' },
    env: {},
    log: (level, message) => warnings.push({ level, message }),
  })
  t.after(() => hook?.close())
  const listener = ctx.listeners.find((item) => item.event === PRE_STEP_EVENT)

  const decision = await runHook(listener, {
    agent: mockAgent({ cwd: dir }),
    messages: [userMessage('память проекта')],
    turn: 1,
    step: 1,
    signal: { aborted: false },
  })
  assert.deepEqual(decision.messages, [])
  assert.ok(warnings.some((item) => item.level === 'warn' && /инъекция памяти пропущена/.test(item.message)))
})

test('добавка хука к ходу ≤ 50 мс после разогрева', async (t) => {
  const { listener, dbDir } = setupHook(t, { entries: Array.from({ length: 20 }, (_, index) => ({ title: `Память ${index}` })) })
  const payload = {
    agent: mockAgent({ cwd: dbDir }),
    messages: [userMessage('память проекта')],
    turn: 1,
    step: 1,
    signal: { aborted: false },
  }
  await runHook(listener, payload)
  const startedAt = performance.now()
  await runHook(listener, payload)
  const duration = performance.now() - startedAt
  assert.ok(duration <= 50, `хук добавил ${duration} мс`)
})

test('createPluginMessage: форма сообщения, заморозка и уникальный id', () => {
  const first = createPluginMessage('[memory] x')
  const second = createPluginMessage('[memory] y')

  assert.equal(first.role, 'user')
  assert.equal(first.source.kind, 'plugin')
  assert.equal(first.source.plugin, 'dsh-memory')
  assert.deepEqual(first.source.sections, [{ name: 'dsh-memory', text: '[memory] x' }])
  assert.deepEqual(first.content, [{ type: 'text', text: '[memory] x' }])
  assert.ok(Object.isFrozen(first))
  assert.ok(Object.isFrozen(first.content))
  assert.ok(Object.isFrozen(first.content[0]))
  assert.ok(Object.isFrozen(first.source))
  assert.notEqual(first.id, second.id)
})

test('lastUserMessageFromSession берёт последнее human-сообщение', () => {
  const agent = mockAgent({
    events: [
      { type: 'user/message', data: userMessage('первое') },
      { type: 'user/message', data: userMessage('второе') },
      { type: 'user/message', data: userMessage('[memory] вставка', { kind: 'plugin', plugin: 'dsh-memory' }) },
    ],
  })
  assert.equal(lastUserMessageFromSession(agent), 'второе')
  assert.equal(lastUserMessageFromSession({}), '')
})
