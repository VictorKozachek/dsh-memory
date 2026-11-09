/**
 * Тесты `memory.stats` и событий `metrics`: search/write/verify пишутся в
 * таблицу `metrics`, hit-rate и оценка сэкономленных токенов считаются по
 * событиям, пустая база и битые события не роняют статистику.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  METRIC_EVENTS,
  memoryStats,
  queryHash,
  recordSearchMetric,
  estimateSavedTokens,
} from '../lib/metrics.js'
import { searchMemory } from '../lib/search.js'
import { openStore } from '../lib/store.js'
import { verifyMemory } from '../lib/verify.js'
import { writeMemory } from '../lib/write.js'

const DAY = 24 * 60 * 60 * 1_000
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0)

/** Открыть хранилище на временном каталоге; закрывается после теста. */
function tempStore(t, namespace = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-metrics-'))
  const store = openStore({ dbPath: dir, namespace, now: () => NOW })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

/** События типа `event` из metrics. */
function events(store, event) {
  return store.listMetrics({ event })
}

test('queryHash нормализует запрос и не пишет сам текст', () => {
  assert.equal(queryHash('  DSH-Memory   '), queryHash('dsh-memory'))
  assert.notEqual(queryHash('память'), queryHash('память проекта'))
  assert.match(queryHash('память'), /^[0-9a-f]{64}$/)
})

test('recordSearchMetric пишет query_hash, hits, latency_ms и tokens_saved', (t) => {
  const store = tempStore(t)
  recordSearchMetric(store, { query: 'Память', hits: 2, latencyMs: 3.5, tokensSaved: 120 })

  const [metric] = events(store, 'search')
  assert.equal(metric.event, 'search')
  assert.equal(metric.ts, NOW)
  assert.equal(metric.payload.query_hash, queryHash('память'))
  assert.equal(metric.payload.hits, 2)
  assert.equal(metric.payload.latency_ms, 3.5)
  assert.equal(metric.payload.tokens_saved, 120)
  // Полный текст запроса в metrics не попадает.
  assert.ok(!JSON.stringify(metric.payload).includes('Память'))
})

test('memory.write и memory.verify пишут события write и verify', (t) => {
  const store = tempStore(t)
  const input = {
    kind: 'fact',
    title: 'Метрика',
    text: 'событие записи',
    sources: [{ path: 'docs/a.md' }],
  }

  const written = writeMemory(store, input, { now: () => NOW })
  const [firstWrite] = events(store, 'write')
  assert.equal(firstWrite.payload.kind, 'fact')
  assert.equal(firstWrite.payload.status, 'draft')
  assert.equal(firstWrite.payload.deduped, false)
  assert.equal(firstWrite.payload.sources_count, 1)

  // Дубль по hash — отдельное событие с deduped: true.
  writeMemory(store, input, { now: () => NOW + 1_000 })
  const writes = events(store, 'write')
  assert.equal(writes.length, 2)
  assert.equal(writes[1].payload.deduped, true)

  verifyMemory(store, { id: written.id, verified_by: 'tester' }, { now: () => NOW + 2 * DAY })
  const [verify] = events(store, 'verify')
  assert.equal(verify.payload.id, written.id)
  assert.equal(verify.payload.verified_by, 'tester')
  assert.equal(verify.payload.days_since_created, 2)
})

test('memory.search пишет событие search с числом попаданий и экономией', (t) => {
  const store = tempStore(t)
  store.insertEntry({
    kind: 'fact',
    title: 'Память',
    text: 'память проекта на SQLite',
    status: 'verified',
    confidence: 1,
    createdAt: NOW,
    updatedAt: NOW,
  })

  const results = searchMemory(store, { query: 'память' }, { now: () => NOW })
  assert.equal(results.length, 1)

  const [metric] = events(store, 'search')
  assert.equal(metric.payload.query_hash, queryHash('память'))
  assert.equal(metric.payload.hits, 1)
  assert.ok(metric.payload.latency_ms >= 0)
  assert.equal(metric.payload.tokens_saved, estimateSavedTokens(results))
  assert.ok(metric.payload.tokens_saved > 0)

  // Поиск без попаданий — событие с hits: 0 и нулевой экономией.
  searchMemory(store, { query: 'нет-такого-слова' }, { now: () => NOW })
  const searches = events(store, 'search')
  assert.equal(searches.length, 2)
  assert.equal(searches[1].payload.hits, 0)
  assert.equal(searches[1].payload.tokens_saved, 0)
})

test('stats на пустой базе — нули, без NaN и исключений', (t) => {
  const store = tempStore(t)
  assert.deepEqual(memoryStats(store), {
    entries: 0,
    by_status: { draft: 0, verified: 0, stale: 0 },
    hit_rate: 0,
    tokens_saved_estimate: 0,
  })
})

test('stats считает записи и статусы', (t) => {
  const store = tempStore(t)
  const add = (status) => store.insertEntry({
    kind: 'fact',
    title: `Запись ${status} ${Math.random()}`,
    text: 'текст',
    status,
    createdAt: NOW,
    updatedAt: NOW,
  })
  add('draft')
  add('draft')
  add('verified')
  add('stale')

  const stats = memoryStats(store)
  assert.equal(stats.entries, 4)
  assert.deepEqual(stats.by_status, { draft: 2, verified: 1, stale: 1 })
})

test('hit_rate считается по событиям search и округляется', (t) => {
  const store = tempStore(t)
  recordSearchMetric(store, { query: 'a', hits: 0, latencyMs: 1, tokensSaved: 0 })
  recordSearchMetric(store, { query: 'b', hits: 2, latencyMs: 1, tokensSaved: 100 })
  recordSearchMetric(store, { query: 'c', hits: 1, latencyMs: 1, tokensSaved: 50 })

  const stats = memoryStats(store)
  assert.equal(stats.hit_rate, 0.667)
  assert.equal(stats.tokens_saved_estimate, 150)
  assert.equal(stats.entries, 0)
})

test('stats не падает на битых и старых событиях', (t) => {
  const store = tempStore(t)
  // Ручные/старые строки: payload не JSON, NULL и событие без tokens_saved.
  store.database.prepare('INSERT INTO metrics (ts, event, payload) VALUES (?, ?, ?)').run(NOW, 'search', 'not json')
  store.database.prepare('INSERT INTO metrics (ts, event, payload) VALUES (?, ?, ?)').run(NOW, 'search', null)
  recordSearchMetric(store, { query: 'битое', hits: 1, latencyMs: 0 })

  const stats = memoryStats(store)
  assert.equal(stats.hit_rate, 0.333)
  // Старое событие с hits > 0 без tokens_saved: грубая оценка 100 на попадание.
  assert.equal(stats.tokens_saved_estimate, 100)
})

test('METRIC_EVENTS перечисляет события памяти', () => {
  for (const event of ['search', 'write', 'verify', 'route']) {
    assert.ok(METRIC_EVENTS.includes(event))
  }
})
