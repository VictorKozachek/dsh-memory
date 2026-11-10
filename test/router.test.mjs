/**
 * Тесты жёсткого роутера L2→L3 (задача 017): выбор слоя по уверенности,
 * fallback при NO_ANSWER/ошибке/таймауте, отмена, стриминг L3, route-метрики и
 * отсутствие регрессии при выключенном флаге.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ROUTER_DEFAULTS, RouterTimeoutError, resolveRouterConfig, routeTurn } from '../lib/router.js'
import { openStore } from '../lib/store.js'

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
