/**
 * `memory.stats` и события `metrics` (задача 007).
 *
 * Схема §5.1 хранит события строкой `metrics(ts, event, payload)`. Здесь —
 * контракт событий и сводка:
 * - `search` — `{ query_hash, hits, latency_ms, tokens_saved }`;
 * - `write` — `{ kind, status, deduped, sources_count }`;
 * - `verify` — `{ id, verified_by, days_since_created }`;
 * - `route` (задача 011) — `{ layer, reason, tokens_saved_estimate }`.
 *
 * `memory.stats` считает по этим событиям `hit_rate` (доля поисков с
 * попаданиями) и `tokens_saved_estimate` (сумма оценок сэкономленных токенов
 * по успешным поискам). Пустая база и отсутствие событий дают нули, а не
 * `NaN`/исключение. Запись метрик — вспомогательная: ошибка записи не должна
 * ронять сам инструмент (риск из PLAN.md «плагин молчит при ошибке»), поэтому
 * вызывающие оборачивают её в try/catch (см. `search`/`write`/`verify`).
 *
 * @module dsh-memory/metrics
 */

import { createHash } from 'node:crypto'

import { estimateTokens } from './indexer.js'

/** Типы событий памяти (спека §10; `route` добавит 011). */
export const METRIC_EVENTS = Object.freeze(['search', 'write', 'verify', 'route'])

/** Сколько токенов в среднем экономит один удачный поиск без сниппета. */
const FALLBACK_TOKENS_PER_HIT = 100

/**
 * Хэш запроса для метрик: нормализованный текст (trim, нижний регистр,
 * схлопнутые пробелы) → sha256 hex. Сам текст запроса в metrics не пишется.
 *
 * @param {string} query — запрос.
 * @returns {string} hex-хэш.
 */
export function queryHash(query) {
  const normalized = String(query ?? '').trim().toLowerCase().replace(/\s+/gu, ' ')
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/**
 * Оценить, сколько токенов сэкономил поиск: сумма оценок длины сниппетов,
 * которые получил вызывающий (полный текст в сниппет не попадает).
 *
 * @param {ReadonlyArray<{ snippet?: string }>} results — результаты поиска.
 * @returns {number} оценка токенов.
 */
export function estimateSavedTokens(results) {
  let saved = 0
  for (const result of results) saved += estimateTokens(result?.snippet ?? '')
  return saved
}

/**
 * Записать событие `search`.
 *
 * @param {import('./store.js').MemoryStore} store — хранилище.
 * @param {object} event — данные события.
 * @param {string} event.query — исходный запрос (в метрику идёт только хэш).
 * @param {number} event.hits — сколько записей вернул поиск.
 * @param {number} event.latencyMs — длительность поиска, мс.
 * @param {number} [event.tokensSaved] — оценка сэкономленных токенов.
 * @param {boolean} [event.injected] — попал ли блок памяти в ход (спека §10).
 * @returns {void}
 */
export function recordSearchMetric(store, { query, hits, latencyMs, tokensSaved = 0, injected = false }) {
  store.recordMetric('search', {
    query_hash: queryHash(query),
    hits: Math.max(0, Math.trunc(Number(hits) || 0)),
    latency_ms: Math.max(0, Number(latencyMs) || 0),
    tokens_saved: Math.max(0, Math.trunc(Number(tokensSaved) || 0)),
    injected: Boolean(injected),
  })
}

/**
 * Записать событие `write`.
 *
 * @param {import('./store.js').MemoryStore} store — хранилище.
 * @param {object} event — данные события.
 * @param {string} event.kind — тип записи.
 * @param {string} event.status — итоговый статус записи.
 * @param {boolean} event.deduped — был ли это дубль по hash.
 * @param {number} event.sourcesCount — сколько источников пришло.
 * @returns {void}
 */
export function recordWriteMetric(store, { kind, status, deduped, sourcesCount }) {
  store.recordMetric('write', {
    kind,
    status,
    deduped: Boolean(deduped),
    sources_count: Math.max(0, Math.trunc(Number(sourcesCount) || 0)),
  })
}

/**
 * Записать событие `verify`.
 *
 * @param {import('./store.js').MemoryStore} store — хранилище.
 * @param {object} event — данные события.
 * @param {number} event.id — идентификатор записи.
 * @param {string} event.verifiedBy — кто подтвердил.
 * @param {number} event.daysSinceCreated — сколько дней прожила запись до подтверждения.
 * @returns {void}
 */
export function recordVerifyMetric(store, { id, verifiedBy, daysSinceCreated }) {
  store.recordMetric('verify', {
    id,
    verified_by: verifiedBy,
    days_since_created: Math.max(0, Math.trunc(Number(daysSinceCreated) || 0)),
  })
}

/**
 * Сводка памяти: сколько записей, статусы, hit-rate и оценка сэкономленных
 * токенов. Работает и на пустой базе (нули, без исключений).
 *
 * @param {import('./store.js').MemoryStore} store — хранилище.
 * @returns {{ entries: number, by_status: { draft: number, verified: number, stale: number }, hit_rate: number, tokens_saved_estimate: number }} сводка.
 */
export function memoryStats(store) {
  if (!store || typeof store.countEntries !== 'function' || typeof store.listMetrics !== 'function') {
    throw new TypeError('dsh-memory: memory.stats нужен открытый store (см. lib/store.js)')
  }

  const byStatus = { draft: 0, verified: 0, stale: 0 }
  for (const row of store.countEntriesByStatus()) {
    if (Object.hasOwn(byStatus, row.status)) byStatus[row.status] = row.count
  }

  const searches = store.listMetrics({ event: 'search' })
  let hitSearches = 0
  let tokensSaved = 0
  for (const metric of searches) {
    const payload = metric.payload ?? {}
    const hits = Number(payload.hits)
    if (Number.isFinite(hits) && hits > 0) hitSearches += 1
    const saved = Number(payload.tokens_saved)
    if (Number.isFinite(saved) && saved > 0) {
      tokensSaved += saved
    } else if (Number.isFinite(hits) && hits > 0) {
      // Старое событие без tokens_saved: грубая оценка по числу попаданий.
      tokensSaved += Math.trunc(hits) * FALLBACK_TOKENS_PER_HIT
    }
  }

  return {
    entries: store.countEntries(),
    by_status: byStatus,
    hit_rate: searches.length === 0 ? 0 : round(hitSearches / searches.length),
    tokens_saved_estimate: tokensSaved,
  }
}

/**
 * Округлить hit-rate до тысячных, чтобы 2/3 не выглядело как 0.6666666666666.
 *
 * @param {number} value — значение 0..1.
 * @returns {number} округлённое значение.
 */
function round(value) {
  return Math.round(value * 1_000) / 1_000
}
