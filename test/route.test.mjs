/**
 * Тесты метрик каскада и интеграции с `dsh-token-meter` (задача 011):
 * route-события, опциональный token-meter (estimate/publish), no-op без него,
 * агрегация экономии в `memory.stats`.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { estimateTokens } from '../lib/indexer.js'
import { ROUTE_LAYERS, memoryStats, recordRouteMetric, recordSearchMetric } from '../lib/metrics.js'
import { createRouteReporter } from '../lib/route.js'
import { openStore } from '../lib/store.js'
import { createTokenMeterAdapter, optionalTokenMeter } from '../lib/token-meter.js'

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0)

/** Открыть хранилище на временном каталоге; закрывается после теста. */
function tempStore(t, namespace = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-route-'))
  const store = openStore({ dbPath: dir, namespace, now: () => NOW })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

/** События route. */
function routeEvents(store) {
  return store.listMetrics({ event: 'route' })
}

test('recordRouteMetric пишет layer/reason/savings/injected в metrics', (t) => {
  const store = tempStore(t)
  const payload = recordRouteMetric(store, { layer: 'L2', reason: 'memory hit', tokensSavedEstimate: 500 })

  assert.deepEqual(payload, { layer: 'L2', reason: 'memory hit', tokens_saved_estimate: 500, injected_tokens: 0 })
  const [metric] = routeEvents(store)
  assert.equal(metric.event, 'route')
  assert.equal(metric.ts, NOW)
  assert.deepEqual(metric.payload, payload)
  assert.deepEqual(ROUTE_LAYERS, ['L1', 'L2', 'L3'])
})

test('recordRouteMetric валидирует решение каскада', (t) => {
  const store = tempStore(t)

  assert.throws(() => recordRouteMetric(store, { layer: 'L4', reason: 'x', tokensSavedEstimate: 1 }), /layer/)
  assert.throws(() => recordRouteMetric(store, { layer: 'L2', reason: '   ', tokensSavedEstimate: 1 }), /reason/)
  assert.throws(() => recordRouteMetric(store, { layer: 'L2', reason: 'x', tokensSavedEstimate: -1 }), /tokens_saved_estimate/)
  assert.throws(() => recordRouteMetric(store, { layer: 'L2', reason: 'x', tokensSavedEstimate: 'много' }), /tokens_saved_estimate/)
  assert.throws(() => recordRouteMetric(store, { layer: 'L1', reason: 'x', tokensSavedEstimate: 0, injectedTokens: -1 }), /injected_tokens/)
  // Экономия возможна только на L2: L1 — расход, L3 — основная модель.
  assert.throws(() => recordRouteMetric(store, { layer: 'L1', reason: 'injection', tokensSavedEstimate: 1000 }), /только на L2/)
  assert.throws(() => recordRouteMetric(store, { layer: 'L3', reason: 'main model', tokensSavedEstimate: 500 }), /только на L2/)
  assert.equal(routeEvents(store).length, 0)
})

test('без token-meter: оценка локальная, публикация — no-op', (t) => {
  const store = tempStore(t)
  const reporter = createRouteReporter(store)

  assert.equal(reporter.available, false)
  const text = 'Ответ дешёвой сабмодели, которого хватило без основной модели'
  const result = reporter.record({ layer: 'L2', reason: 'cheap answer', text })

  assert.equal(result.layer, 'L2')
  assert.equal(result.tokens_saved_estimate, estimateTokens(text))
  assert.equal(result.published, false)
  assert.equal(result.injected_tokens, 0)
  assert.deepEqual(routeEvents(store).map((metric) => metric.payload), [{
    layer: 'L2',
    reason: 'cheap answer',
    tokens_saved_estimate: estimateTokens(text),
    injected_tokens: 0,
  }])
})

test('реальная форма token-meter (только estimateMessage): L1 — расход, публикации нет', (t) => {
  const store = tempStore(t)
  // У настоящего ctx.tokenMeter есть только measure()/estimateMessage(); publish
  // и record у него отсутствуют, поэтому тест не подсовывает несуществующий API.
  const tokenMeter = {
    estimateMessage: (message) => {
      // Решение диспетчера: duck-typed Message, сервис читает только content.
      assert.equal(message.content[0].type, 'text')
      return 42
    },
  }
  const reporter = createRouteReporter(store, { tokenMeter })

  assert.equal(reporter.available, true)
  const result = reporter.record({ layer: 'L1', reason: 'injection hit', text: 'память проекта' })
  assert.equal(result.tokens_saved_estimate, 0, 'L1-инъекция — расход, а не экономия')
  assert.equal(result.injected_tokens, 42)
  assert.equal(result.published, false, 'у token-meter нет канала публикации — метрика остаётся в metrics')
  assert.equal(routeEvents(store)[0].payload.tokens_saved_estimate, 0)
  assert.equal(routeEvents(store)[0].payload.injected_tokens, 42)
})

test('L2 вместо L3: route пишет экономию, без расхода на инъекцию', (t) => {
  const store = tempStore(t)
  const reporter = createRouteReporter(store, { tokenMeter: { estimateMessage: () => 500 } })

  const result = reporter.record({ layer: 'L2', reason: 'cheap answer', text: 'ответ сабмодели' })
  assert.equal(result.tokens_saved_estimate, 500)
  assert.equal(result.injected_tokens, 0)
  assert.equal(result.published, false)
})

test('L3 (основная модель) по умолчанию не даёт экономии и не считается в stats', (t) => {
  const store = tempStore(t)
  const reporter = createRouteReporter(store, { tokenMeter: { estimateMessage: () => 500 } })

  const result = reporter.record({ layer: 'L3', reason: 'main model answer', text: 'ответ основной модели' })
  assert.equal(result.tokens_saved_estimate, 0, 'ответ L3 — не экономия, а обычный расход')
  assert.equal(result.injected_tokens, 0)
  assert.equal(memoryStats(store).tokens_saved_estimate, 0)
  assert.equal(routeEvents(store).length, 1)
})

test('ошибки token-meter не ломают запись route', (t) => {
  const store = tempStore(t)
  const throwing = { estimateMessage: () => { throw new Error('meter down') } }
  const reporter = createRouteReporter(store, { tokenMeter: throwing })

  const result = reporter.record({ layer: 'L2', reason: 'fallback', text: 'ответ' })
  assert.equal(result.tokens_saved_estimate, estimateTokens('ответ'))
  assert.equal(result.published, false)
  assert.equal(routeEvents(store).length, 1)
})

test('createTokenMeterAdapter: реальная форма API и fallback', () => {
  const heuristic = createTokenMeterAdapter(undefined)
  assert.equal(heuristic.available, false)
  assert.equal(heuristic.estimate('абвгд'), estimateTokens('абвгд'))
  assert.equal(heuristic.publish({}), false)

  const meter = createTokenMeterAdapter({ estimateMessage: () => 11 })
  assert.equal(meter.available, true)
  assert.equal(meter.estimate('x'), 11)
  assert.equal(meter.publish({ event: 'route' }), false, 'publish на реальном token-meter — no-op')
})

test('optionalTokenMeter: ctx.get / свойство / отсутствие / исключение', () => {
  const service = { estimateMessage: () => 1 }
  assert.equal(optionalTokenMeter({ get: () => service }), service)
  assert.equal(optionalTokenMeter({ tokenMeter: service }), service)
  assert.equal(optionalTokenMeter({}), undefined)
  assert.equal(optionalTokenMeter({ get: () => { throw new Error('boom') } }), undefined)
})

test('stats: L1 — расход, savings только L2/L3, hit_rate по search', (t) => {
  const store = tempStore(t)
  recordSearchMetric(store, { query: 'память', hits: 1, latencyMs: 1, tokensSaved: 100, injected: true })
  recordSearchMetric(store, { query: 'зебра', hits: 0, latencyMs: 1 })

  const before = memoryStats(store)
  assert.equal(before.hit_rate, 0.5)
  assert.equal(before.tokens_saved_estimate, 0, 'L1/search-инъекции не считаются экономией в MVP')
  assert.equal(before.injected_tokens, 0)

  recordRouteMetric(store, { layer: 'L1', reason: 'memory injection', tokensSavedEstimate: 0, injectedTokens: 300 })
  recordRouteMetric(store, { layer: 'L2', reason: 'cheap answer', tokensSavedEstimate: 500 })
  recordRouteMetric(store, { layer: 'L3', reason: 'escalation', tokensSavedEstimate: 0 })

  const after = memoryStats(store)
  assert.equal(after.hit_rate, 0.5)
  assert.equal(after.injected_tokens, 300, 'суммарный расход на инъекции памяти')
  assert.equal(after.tokens_saved_estimate, 500, 'экономия — только L2 вместо L3')
})

test('stats не падает на битом route-событии', (t) => {
  const store = tempStore(t)
  store.database.prepare('INSERT INTO metrics (ts, event, payload) VALUES (?, ?, ?)').run(NOW, 'route', 'not json')

  const stats = memoryStats(store)
  assert.equal(stats.tokens_saved_estimate, 0)
  assert.equal(stats.injected_tokens, 0)
  assert.equal(stats.hit_rate, 0)
})
