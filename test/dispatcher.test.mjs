/**
 * Тесты живого диспетчера (задача 025): флаг off/on, hook после промаха L1,
 * fallback на L3, отмена и mock AgentLoop.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as plugin from '../lib/index.js'
import { createLiveDispatcher } from '../lib/live-dispatcher.js'

/** Роль для конфига. */
function role(overrides = {}) {
  return {
    name: 'developer',
    prompt: 'Ты разработчик проекта.',
    model: 'cheap-model',
    namespace: 'demo',
    responsibilities: ['реализация'],
    priority: 20,
    ...overrides,
  }
}

/** Конфиг с включённым диспетчером. */
function config(dir, overrides = {}) {
  return {
    db_path: dir,
    namespace: 'demo',
    inject: { enabled: true, top_k: 3, token_budget: 600 },
    search: { snippet_chars: 300 },
    dispatcher: {
      enabled: true,
      strategy: 'priority',
      timeout_ms: 100,
      default_role: 'developer',
      roles: [role()],
    },
    ...overrides,
  }
}

/** Мок cordis-контекста. */
function mockContext() {
  const listeners = []
  return {
    listeners,
    on(event, handler, options) { listeners.push({ event, handler, options }); return () => {} },
    effect() { return () => {} },
  }
}

/** Каталог на тест. */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-dispatcher-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Human-сообщение. */
function userMessage(text) {
  return { id: `m-${Math.random()}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** Получить зарегистрированный hook и сервис memory. */
function setup(t, options) {
  const ctx = mockContext()
  let memory
  ctx.provide = (name, service) => { memory = service }
  ctx.logs = []
  ctx.logger = { debug: (message) => ctx.logs.push(message), info: (message) => ctx.logs.push(message), warn: (message) => ctx.logs.push(message) }
  plugin.apply(ctx, options)
  const listener = ctx.listeners.find((item) => item.event === 'agent/pre-step')
  return { ctx, memory, listener }
}

/** Mock AgentLoop: L2 при ответе диспетчера, иначе L3; отмена — стоп. */
async function runAgentLoop(listener, payload, calls) {
  const decision = await listener.handler(payload, async () => ({ kind: 'enter', messages: [] }))
  const dispatcherMessage = decision.messages.find((message) => message?.source?.plugin === 'dsh-memory-dispatcher')
  if (dispatcherMessage) {
    calls.push('L2')
    return { layer: 'L2', answer: dispatcherMessage.content[0].text }
  }
  if (payload.signal?.aborted) {
    calls.push('aborted')
    return { layer: 'aborted' }
  }
  calls.push('L3')
  return { layer: 'L3' }
}

test('live dispatcher: флаг off не вызывает диспетчер, fallback с причиной', async () => {
  const live = createLiveDispatcher({ config: { dispatcher: { enabled: false, roles: [role()] } } })
  assert.equal(live.enabled, false)
  const result = await live.dispatch({ task: 'задача' })
  assert.equal(result.fallback, true)
  assert.match(result.reason, /disabled/)
})

test('live dispatcher: роли + провайдер + planner дают ответ', async () => {
  const live = createLiveDispatcher({
    config: { dispatcher: { enabled: true, default_role: 'developer', roles: [role()] } },
  })
  assert.equal(live.enabled, true)
  live.registerProvider('developer', async ({ role: roleInfo, subtopic }) => ({
    answer: `${roleInfo.name}: ${subtopic.text}`,
    confidence: 0.9,
    sources: ['src/app.js'],
  }))
  const result = await live.dispatch({ task: 'сделать API' })
  assert.equal(result.fallback, false)
  assert.equal(result.answer, 'developer: сделать API')
  assert.equal(result.role, 'developer')

  const planned = createLiveDispatcher({ config: { dispatcher: { enabled: true, roles: [role()] } } })
  planned.registerProvider('developer', async () => ({ answer: 'planned', confidence: 0.8 }))
  planned.registerPlanner(() => [{ id: 'a', text: 'подтема', role: 'developer' }])
  assert.equal((await planned.dispatch({ task: 'задача' })).answer, 'planned')
})

test('live dispatcher: нет провайдера/ошибка/пустой ответ — fallback, не исключение', async () => {
  const noProvider = createLiveDispatcher({ config: { dispatcher: { enabled: true, roles: [role()] } } })
  const result = await noProvider.dispatch({ task: 'задача' })
  assert.equal(result.fallback, true)
  assert.match(result.reason, /не ответили|план/)

  const broken = createLiveDispatcher({ config: { dispatcher: { enabled: true, roles: [role()] } } })
  broken.registerProvider('developer', async () => { throw new Error('down') })
  const failed = await broken.dispatch({ task: 'задача' })
  assert.equal(failed.fallback, true)
  assert.match(failed.reason, /не ответили|план/)
})

test('hook: флаг off не вызывает провайдера, AgentLoop идёт на L3', async (t) => {
  const dir = tempDir(t)
  const { memory, listener } = setup(t, config(dir, { dispatcher: { enabled: false } }))
  let called = 0
  memory.registerRoleProvider('developer', async () => { called += 1; return { answer: 'L2' } })
  const calls = []
  const result = await runAgentLoop(listener, { agent: { session: { header: { cwd: dir } } }, messages: [userMessage('неизвестный запрос')], turn: 1, step: 1, signal: { aborted: false } }, calls)
  assert.equal(result.layer, 'L3')
  assert.equal(called, 0)
})

test('hook+AgentLoop: флаг on, ответ диспетчера обслуживает ход (L2), без L3', async (t) => {
  const dir = tempDir(t)
  const { memory, listener } = setup(t, config(dir))
  memory.registerRoleProvider('developer', async ({ subtopic }) => ({ answer: `роль: ${subtopic.text}`, confidence: 0.9, sources: ['src/app.js'] }))
  assert.equal(memory.dispatcherEnabled, true)
  const calls = []
  const result = await runAgentLoop(listener, { agent: { session: { header: { cwd: dir } } }, messages: [userMessage('сделай API')], turn: 1, step: 1, signal: { aborted: false } }, calls)
  assert.deepEqual(calls, ['L2'])
  assert.equal(result.layer, 'L2')
  assert.equal(result.answer, 'роль: сделай API')

})

test('hook+AgentLoop: нет провайдера — fallback на L3', async (t) => {
  const dir = tempDir(t)
  const logs = []
  const ctx = mockContext()
  let memory
  ctx.provide = (name, service) => { memory = service }
  ctx.logger = { debug: (message) => logs.push(message), info: () => {}, warn: (message) => logs.push(message) }
  plugin.apply(ctx, config(dir))
  const listener = ctx.listeners.find((item) => item.event === 'agent/pre-step')
  const calls = []
  const result = await runAgentLoop(listener, { agent: { session: { header: { cwd: dir } } }, messages: [userMessage('сделай API')], turn: 1, step: 1, signal: { aborted: false } }, calls)
  assert.deepEqual(calls, ['L3'])
  assert.equal(result.layer, 'L3')
  assert.ok(memory.dispatcherEnabled)
  assert.ok(logs.some((line) => line.includes('dispatcher fallback')), logs.join('\n'))
})

test('hook+AgentLoop: отмена отменяет диспетчер и не уходит в L3', async (t) => {
  const dir = tempDir(t)
  const { memory, listener } = setup(t, config(dir))
  const controller = new AbortController()
  let sawAbort = false
  memory.registerRoleProvider('developer', (input) => new Promise((resolve, reject) => {
    input.signal.addEventListener('abort', () => {
      sawAbort = true
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }, { once: true })
  }))
  setTimeout(() => controller.abort(), 10)
  const calls = []
  const result = await runAgentLoop(listener, {
    agent: { session: { header: { cwd: dir } } },
    messages: [userMessage('сделай API')],
    turn: 1,
    step: 1,
    signal: controller.signal,
  }, calls)
  assert.equal(sawAbort, true)
  assert.deepEqual(calls, ['aborted'])
  assert.equal(result.layer, 'aborted')
})

test('hook: dispatcher.enabled без ролей — disabled, поведение как раньше', async (t) => {
  const dir = tempDir(t)
  const { memory, listener } = setup(t, config(dir, { dispatcher: { enabled: true, roles: [] } }))
  assert.equal(memory.dispatcherEnabled, false)
  const calls = []
  const result = await runAgentLoop(listener, { agent: { session: { header: { cwd: dir } } }, messages: [userMessage('запрос')], turn: 1, step: 1, signal: { aborted: false } }, calls)
  assert.equal(result.layer, 'L3')
  assert.deepEqual(calls, ['L3'])
})


test('planner получает AbortSignal; невалидный реестр ролей не роняет apply', async () => {
  const controller = new AbortController()
  let plannerSignal = null
  const live = createLiveDispatcher({ config: { dispatcher: { enabled: true, roles: [role()] } } })
  live.registerProvider('developer', async () => ({ answer: 'ok', confidence: 0.8 }))
  live.registerPlanner((input) => {
    plannerSignal = input.signal
    return [{ id: 'a', text: 'подтема', role: 'developer' }]
  })
  const result = await live.dispatch({ task: 'задача', signal: controller.signal })
  assert.equal(result.answer, 'ok')
  assert.equal(plannerSignal, controller.signal)

  const broken = createLiveDispatcher({ config: { dispatcher: { enabled: true, roles: [{ name: 'Bad Name' }] } }, logger: () => {} })
  assert.equal(broken.enabled, false)
  assert.equal((await broken.dispatch({ task: 'задача' })).fallback, true)
})


test('live dispatcher: plan_timeout_ms и max_subtasks из конфига', async () => {
  const live = createLiveDispatcher({
    config: { dispatcher: { enabled: true, plan_timeout_ms: 20, max_subtasks: 2, default_role: 'developer', roles: [role()] } },
  })
  live.registerProvider('developer', async ({ subtopic }) => ({ answer: subtopic.text, confidence: 0.9 }))
  live.registerPlanner(() => new Promise(() => {}))
  const startedAt = Date.now()
  const timedOut = await live.dispatch({ task: 'задача' })
  assert.equal(timedOut.fallback, true)
  assert.ok(Date.now() - startedAt < 300)

  live.registerPlanner(() => ['a', 'b', 'c'])
  const limited = await live.dispatch({ task: 'задача' })
  assert.equal(limited.fallback, false)
  assert.equal(limited.answer.split('\n\n').length, 2)
})
