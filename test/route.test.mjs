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

test('recordRouteMetric пишет layer/reason/tokens_saved_estimate в metrics', (t) => {
  const store = tempStore(t)
  const payload = recordRouteMetric(store, { layer: 'L1', reason: 'memory hit', tokensSavedEstimate: 500 })

  assert.deepEqual(payload, { layer: 'L1', reason: 'memory hit', tokens_saved_estimate: 500 })
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
  assert.deepEqual(routeEvents(store).map((metric) => metric.payload), [{
    layer: 'L2',
    reason: 'cheap answer',
    tokens_saved_estimate: estimateTokens(text),
  }])
})

test('с token-meter: estimateMessage и publish используются', (t) => {
  const store = tempStore(t)
  const published = []
  const tokenMeter = {
    estimateMessage: (message) => {
      assert.equal(message.content[0].type, 'text')
      return 42
    },
    publish: (metric) => published.push(metric),
  }
  const reporter = createRouteReporter(store, { tokenMeter })

  assert.equal(reporter.available, true)
  const result = reporter.record({ layer: 'L1', reason: 'injection hit', text: 'память проекта' })
  assert.equal(result.tokens_saved_estimate, 42)
  assert.equal(result.published, true)
  assert.deepEqual(published, [{ event: 'route', layer: 'L1', reason: 'injection hit', tokens_saved_estimate: 42 }])
})

test('token-meter без publish: оценка есть, публикация no-op', (t) => {
  const store = tempStore(t)
  const reporter = createRouteReporter(store, { tokenMeter: { estimateMessage: () => 7 } })

  const result = reporter.record({ layer: 'L3', reason: 'escalated', text: 'x' })
  assert.equal(result.tokens_saved_estimate, 7)
  assert.equal(result.published, false)
})

test('ошибки token-meter не ломают запись route', (t) => {
  const store = tempStore(t)
  const throwing = {
    estimateMessage: () => { throw new Error('meter down') },
    publish: () => { throw new Error('publish down') },
  }
  const reporter = createRouteReporter(store, { tokenMeter: throwing })

  const result = reporter.record({ layer: 'L2', reason: 'fallback', text: 'ответ' })
  assert.equal(result.tokens_saved_estimate, estimateTokens('ответ'))
  assert.equal(result.published, false)
  assert.equal(routeEvents(store).length, 1)
})

test('createTokenMeterAdapter: duck-typed API и fallback', () => {
  const heuristic = createTokenMeterAdapter(undefined)
  assert.equal(heuristic.available, false)
  assert.equal(heuristic.estimate('абвгд'), estimateTokens('абвгд'))
  assert.equal(heuristic.publish({}), false)

  const meter = createTokenMeterAdapter({ estimateMessage: () => 11, record: () => {} })
  assert.equal(meter.available, true)
  assert.equal(meter.estimate('x'), 11)
  assert.equal(meter.publish({ event: 'route' }), true)
})

test('optionalTokenMeter: ctx.get / свойство / отсутствие / исключение', () => {
  const service = { estimateMessage: () => 1 }
  assert.equal(optionalTokenMeter({ get: () => service }), service)
  assert.equal(optionalTokenMeter({ tokenMeter: service }), service)
  assert.equal(optionalTokenMeter({}), undefined)
  assert.equal(optionalTokenMeter({ get: () => { throw new Error('boom') } }), undefined)
})

test('stats: route-события авторитетнее search, hit_rate считается по search', (t) => {
  const store = tempStore(t)
  recordSearchMetric(store, { query: 'память', hits: 1, latencyMs: 1, tokensSaved: 100, injected: true })
  recordSearchMetric(store, { query: 'зебра', hits: 0, latencyMs: 1 })

  const before = memoryStats(store)
  assert.equal(before.hit_rate, 0.5)
  assert.equal(before.tokens_saved_estimate, 100)

  recordRouteMetric(store, { layer: 'L1', reason: 'memory hit', tokensSavedEstimate: 500 })
  recordRouteMetric(store, { layer: 'L2', reason: 'cheap answer', tokensSavedEstimate: 300 })

  const after = memoryStats(store)
  assert.equal(after.hit_rate, 0.5)
  assert.equal(after.tokens_saved_estimate, 800, 'при наличии route-событий сумма берётся по ним')
})

test('stats не падает на битом route-событии', (t) => {
  const store = tempStore(t)
  store.database.prepare('INSERT INTO metrics (ts, event, payload) VALUES (?, ?, ?)').run(NOW, 'route', 'not json')

  const stats = memoryStats(store)
  assert.equal(stats.tokens_saved_estimate, 0)
  assert.equal(stats.hit_rate, 0)
})
