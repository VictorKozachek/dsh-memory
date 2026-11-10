/**
 * Тесты жёсткого роутера L2→L3 (задача 017): выбор слоя по уверенности,
 * fallback при NO_ANSWER/ошибке/таймауте, отмена, стриминг L3, route-метрики и
 * отсутствие регрессии при выключенном флаге.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { ROUTER_DEFAULTS, RouterTimeoutError, resolveRouterConfig, routeTurn } from '../lib/router.js'
import { openStore } from '../lib/store.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Временное хранилище для route-метрик. */
function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-router-'))
  const store = openStore({ dbPath: dir, namespace: 'demo' })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

/** Собрать провайдеры со счётчиками вызовов. */
function providers({ l2, l3 } = {}) {
  const calls = { l2: 0, l3: 0 }
  return {
    calls,
    providers: {
      l2: async (input) => {
        calls.l2 += 1
        return l2 === undefined ? { status: 'NO_ANSWER' } : l2(input)
      },
      l3: async (input) => {
        calls.l3 += 1
        return l3 === undefined ? { answer: 'ответ L3', confidence: 1 } : l3(input)
      },
    },
  }
}

test('дефолт роутера выключен: L3 напрямую, без вызова L2', async (t) => {
  const store = tempStore(t)
  const { calls, providers: p } = providers({ l3: () => ({ answer: 'основная модель', confidence: 1 }) })
  const events = []
  const result = await routeTurn({
    query: 'вопрос',
    providers: p,
    store,
    logger: () => {},
    onEvent: (event) => events.push(event),
  })
  assert.deepEqual({ layer: result.layer, answer: result.answer }, { layer: 'L3', answer: 'основная модель' })
  assert.deepEqual(calls, { l2: 0, l3: 1 })
  assert.deepEqual(resolveRouterConfig({}).enabled, false)
  assert.deepEqual(resolveRouterConfig({}), ROUTER_DEFAULTS)
  const [route] = store.listMetrics({ event: 'route' })
  assert.equal(route.payload.layer, 'L3')
  assert.equal(route.payload.reason, 'router disabled')
})

test('уверенный L2 обслуживает ход, L3 не вызывается, экономия пишется в route', async (t) => {
  const store = tempStore(t)
  const { calls, providers: p } = providers({
    l2: () => ({ status: 'ANSWER', answer: 'дешёвый ответ', confidence: 0.9, tokensSavedEstimate: 500 }),
    l3: () => ({ answer: 'основная', confidence: 1 }),
  })
  const events = []
  const result = await routeTurn({
    query: 'вопрос',
    providers: p,
    store,
    config: { router: { enabled: true } },
    onEvent: (event) => events.push(event),
  })
  assert.equal(result.layer, 'L2')
  assert.equal(result.answer, 'дешёвый ответ')
  assert.equal(result.confidence, 0.9)
  assert.equal(result.tokensSavedEstimate, 500)
  assert.deepEqual(calls, { l2: 1, l3: 0 })
  assert.ok(events.some((event) => event.type === 'route' && event.layer === 'L2'))
  const [route] = store.listMetrics({ event: 'route' })
  assert.equal(route.payload.layer, 'L2')
  assert.equal(route.payload.tokens_saved_estimate, 500)
})

test('низкая уверенность, NO_ANSWER, ошибка и таймаут L2 ведут на L3', async (t) => {
  const cases = [
    { name: 'low confidence', l2: () => ({ status: 'ANSWER', answer: 'неуверенно', confidence: 0.4 }), reason: /low confidence/ },
    { name: 'NO_ANSWER', l2: () => ({ status: 'NO_ANSWER' }), reason: /no answer/ },
    { name: 'error', l2: () => { throw new Error('triage down') }, reason: /L2 error/ },
    { name: 'timeout', l2: ({ signal }) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve({ status: 'NO_ANSWER' })); setTimeout(() => resolve({ status: 'NO_ANSWER' }), 100) }), reason: /timeout/ },
  ]
  for (const testCase of cases) {
    const store = tempStore(t)
    const { calls, providers: p } = providers({ l2: testCase.l2, l3: () => ({ answer: 'L3 ответ', confidence: 1 }) })
    const result = await routeTurn({
      query: 'вопрос',
      providers: p,
      store,
      config: { router: { enabled: true, timeout_ms: 20 } },
    })
    assert.equal(result.layer, 'L3', testCase.name)
    assert.equal(result.answer, 'L3 ответ')
    assert.equal(calls.l3, 1, testCase.name)
    assert.match(result.reason, testCase.reason, testCase.name)
    const [route] = store.listMetrics({ event: 'route' })
    assert.equal(route.payload.layer, 'L3', testCase.name)
  }
})

test('таймаут L2 даёт fallback, таймаут L3 — ошибку', async (t) => {
  const store = tempStore(t)
  const { providers: p } = providers({
    l2: () => new Promise(() => {}),
    l3: () => ({ answer: 'L3 после таймаута L2', confidence: 1 }),
  })
  const result = await routeTurn({ query: 'вопрос', providers: p, store, config: { router: { enabled: true, timeout_ms: 20 } } })
  assert.equal(result.layer, 'L3')
  assert.match(result.reason, /timeout/)
  await assert.rejects(
    () => routeTurn({
      query: 'вопрос',
      providers: { l2: () => ({ status: 'NO_ANSWER' }), l3: () => new Promise(() => {}) },
      store,
      config: { router: { enabled: true, timeout_ms: 20 } },
    }),
    (error) => error instanceof RouterTimeoutError || /timeout/.test(error.message),
  )
})

test('внешняя отмена не уходит в L3', async (t) => {
  const store = tempStore(t)
  const controller = new AbortController()
  const { calls, providers: p } = providers({ l2: () => new Promise(() => {}), l3: () => ({ answer: 'L3' }) })
  controller.abort()
  await assert.rejects(
    () => routeTurn({ query: 'вопрос', providers: p, store, config: { router: { enabled: true } }, signal: controller.signal }),
    (error) => error.name === 'AbortError',
  )
  assert.equal(calls.l3, 0)
})

test('стриминг: токены L2 буферизуются, L3 стримится', async (t) => {
  const store = tempStore(t)
  const events = []
  const { providers: p } = providers({
    l2: ({ onToken }) => {
      onToken?.('l2-токен')
      return { status: 'ANSWER', answer: 'L2', confidence: 0.9 }
    },
    l3: ({ onToken }) => {
      onToken?.('a')
      onToken?.('b')
      return { answer: 'ab', confidence: 1 }
    },
  })
  const l2 = await routeTurn({ query: 'q', providers: p, store, config: { router: { enabled: true } }, onEvent: (event) => events.push(event) })
  assert.equal(l2.layer, 'L2')
  assert.ok(!events.some((event) => event.type === 'token'), 'токены L2 не должны утекать до решения')

  events.length = 0
  const low = await routeTurn({
    query: 'q',
    providers: {
      l2: () => ({ status: 'NO_ANSWER' }),
      l3: ({ onToken }) => { onToken?.('a'); onToken?.('b'); return { answer: 'ab', confidence: 1 } },
    },
    store,
    config: { router: { enabled: true } },
    onEvent: (event) => events.push(event),
  })
  assert.equal(low.layer, 'L3')
  assert.deepEqual(events.filter((event) => event.type === 'token').map((event) => event.token), ['a', 'b'])
})

test('пустой ответ L3 — ошибка контракта', async (t) => {
  const store = tempStore(t)
  await assert.rejects(
    () => routeTurn({ query: 'q', providers: { l3: () => ({ answer: '', confidence: 1 }) }, store }),
    /пустой ответ/,
  )
})

test('конфиг роутера: порог/таймаут валидируются', () => {
  assert.deepEqual(resolveRouterConfig({ router: { enabled: true, confidence_threshold: 0.8, timeout_ms: 100 } }), {
    enabled: true,
    confidence_threshold: 0.8,
    timeout_ms: 100,
  })
  assert.deepEqual(resolveRouterConfig({ router: { confidence_threshold: 2, timeout_ms: 0 } }), ROUTER_DEFAULTS)
})

test('отмена во время L2 срабатывает сразу, даже если провайдер игнорирует signal', async (t) => {
  const store = tempStore(t)
  const controller = new AbortController()
  const { calls, providers: p } = providers({
    l2: () => new Promise(() => {}),
    l3: () => ({ answer: 'L3', confidence: 1 }),
  })
  setTimeout(() => controller.abort(), 10)
  const startedAt = Date.now()
  await assert.rejects(
    () => routeTurn({
      query: 'вопрос',
      providers: p,
      store,
      config: { router: { enabled: true, timeout_ms: 500 } },
      signal: controller.signal,
    }),
    (error) => error.name === 'AbortError',
  )
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 200, `отмена заняла ${elapsed} мс (должна быть до таймаута)`)
  assert.equal(calls.l3, 0, 'отменённый ход не должен уходить в L3')
})

test('route-событие приходит до первого токена L3 на всех путях', async (t) => {
  const paths = [
    {
      name: 'disabled',
      config: {},
      providers: {
        l3: ({ onToken }) => { onToken?.('x'); return { answer: 'x', confidence: 1 } },
      },
    },
    {
      name: 'L2 fallback',
      config: { router: { enabled: true } },
      providers: {
        l2: () => ({ status: 'NO_ANSWER' }),
        l3: ({ onToken }) => { onToken?.('x'); return { answer: 'x', confidence: 1 } },
      },
    },
    {
      name: 'L2 unavailable',
      config: { router: { enabled: true } },
      providers: {
        l3: ({ onToken }) => { onToken?.('x'); return { answer: 'x', confidence: 1 } },
      },
    },
  ]

  for (const path of paths) {
    const store = tempStore(t)
    const events = []
    await routeTurn({
      query: 'вопрос',
      providers: path.providers,
      store,
      config: path.config,
      onEvent: (event) => events.push(event),
    })
    const routeIndex = events.findIndex((event) => event.type === 'route')
    const tokenIndex = events.findIndex((event) => event.type === 'token')
    assert.ok(routeIndex >= 0, `${path.name}: нет route-события`)
    assert.ok(tokenIndex > routeIndex, `${path.name}: route должен быть раньше токена`)
  }
})


test('router.enabled false: L3 не ограничен router.timeout_ms (длинный ответ проходит)', async (t) => {
  const store = tempStore(t)
  const { calls, providers: p } = providers({
    l2: () => ({ answer: 'L2', confidence: 1 }),
    l3: () => new Promise((resolve) => setTimeout(() => resolve({ answer: 'медленный L3', confidence: 1 }), 60)),
  })
  const startedAt = Date.now()
  const result = await routeTurn({
    query: 'вопрос',
    providers: p,
    store,
    config: { router: { enabled: false, timeout_ms: 10 } },
  })
  assert.equal(result.layer, 'L3')
  assert.equal(result.answer, 'медленный L3')
  assert.equal(calls.l2, 0)
  assert.ok(Date.now() - startedAt >= 50, 'disabled-путь не должен обрываться таймаутом роутера')
})

test('L2 adapter: голый маркер ANSWER — не ответ, роутер уходит на L3', async (t) => {
  const store = tempStore(t)
  const { calls, providers: p } = providers({
    l2: () => 'ANSWER',
    l3: () => ({ answer: 'L3 после маркера', confidence: 1 }),
  })
  const result = await routeTurn({ query: 'вопрос', providers: p, store, config: { router: { enabled: true } } })
  assert.equal(result.layer, 'L3')
  assert.equal(result.answer, 'L3 после маркера')
  assert.equal(calls.l2, 1)
  assert.equal(calls.l3, 1)

  const dotted = await routeTurn({
    query: 'вопрос',
    providers: { l2: () => 'ANSWER.', l3: () => ({ answer: 'L3', confidence: 1 }) },
    store,
    config: { router: { enabled: true } },
  })
  assert.equal(dotted.layer, 'L3')
})

test('mock AgentLoop: выключенный роутер сохраняет обычный ход (L3, L2 не вызывается)', async (t) => {
  const store = tempStore(t)
  const calls = []
  const agentLoop = {
    async run(query) {
      const route = await routeTurn({
        query,
        providers: {
          l2: async () => { calls.push('l2'); return { answer: 'L2', confidence: 1 } },
          l3: async () => { calls.push('l3'); return { answer: 'ответ хода', confidence: 1 } },
        },
        store,
        config: { router: { enabled: false } },
      })
      return { message: route.answer, layer: route.layer }
    },
  }
  assert.deepEqual(await agentLoop.run('привет'), { message: 'ответ хода', layer: 'L3' })
  assert.deepEqual(calls, ['l3'])
})

test('standalone: висящий L3 даёт RouterTimeoutError, а не выход процесса', () => {
  const script = `
    import { routeTurn } from ${JSON.stringify(pathToFileURL(join(ROOT, 'lib/router.js')).href)};
    routeTurn({
      query: 'q',
      providers: { l2: () => ({ status: 'NO_ANSWER' }), l3: () => new Promise(() => {}) },
      config: { router: { enabled: true, timeout_ms: 30 } },
    }).then(() => console.log('OK')).catch((error) => console.log('ERR', error.name));
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 2_000 })
  assert.equal(child.status, 0, child.stderr)
  assert.match(child.stdout, /ERR RouterTimeoutError/)
  assert.ok(child.signal === null, 'процесс не должен быть убит внешним timeout')
})
