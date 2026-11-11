/**
 * `memory.stats` и события `metrics` (задача 007).
 *
 * Схема §5.1 хранит события строкой `metrics(ts, event, payload)`. Здесь —
 * контракт событий и сводка:
 * - `search` — `{ query_hash, hits, latency_ms, tokens_saved }`;
 * - `write` — `{ kind, status, deduped, sources_count }`;
 * - `verify` — `{ id, verified_by, days_since_created }`;
 * - `route` (задача 011) — `{ layer, reason, tokens_saved_estimate, injected_tokens }`;
 * - `dispatch` (задача 028) — `{ subtopics, roles, durations_ms, strategy, fallback, reason, latency_ms }`
 *   без текста запроса/ответов.
 *
 * Семантика экономии (решение диспетчера по 011): L1-инъекция — это **расход**
 * на контекст (`injected_tokens`), а не экономия, поэтому у L1
 * `tokens_saved_estimate = 0`. Экономия появляется только там, где ход
 * обслужен L2 вместо L3 (012/017) и подтверждена бенчмарком 015. `memory.stats`
 * отдаёт `hit_rate` (доля поисков с попаданиями), `injected_tokens` (расход на
 * инъекции, повторные снапшоты копятся) и `tokens_saved_estimate` (по L2/L3
 * route-событиям; в MVP — 0 до калибровки). Пустая база и отсутствие событий
 * дают нули, а не `NaN`/исключение. Запись метрик — вспомогательная: ошибка
 * записи не должна ронять сам инструмент (риск из PLAN.md «плагин молчит при
 * ошибке»), поэтому вызывающие оборачивают её в try/catch (см.
 * `search`/`write`/`verify`).
 *
 * @module dsh-memory/metrics
 */

import { createHash } from 'node:crypto'

import { estimateTokens } from './indexer.js'

/** Типы событий памяти (спека §10; `route` — 011, `dispatch` — 028). */
export const METRIC_EVENTS = Object.freeze(['search', 'write', 'verify', 'route', 'dispatch'])

/** Слои каскада, которые пишутся в `route` (спека §10). */
export const ROUTE_LAYERS = Object.freeze(['L1', 'L2', 'L3'])

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
 * Записать решение каскада (`route`) в `metrics`: слой, причина, оценка
 * сэкономленных токенов (спека §10) и — по решению диспетчера для 011 —
 * `injected_tokens`: сколько токенов инъекция памяти добавила в историю хода.
 * L1-инъекция — это расход, поэтому у L1 `tokens_saved_estimate = 0`, а
 * `injected_tokens` растёт. Экономия возможна только на L2 (ход обслужен
 * дешёвой сабмоделью вместо основной L3, 012/017), поэтому ненулевой savings у
 * L1/L3 — ошибка контракта: иначе ответ основной модели засчитался бы как
 * экономия. Решение принимает вызывающий слой; функция валидирует и пишет.
 *
 * @param {import('./store.js').MemoryStore} store — хранилище.
 * @param {object} decision — решение каскада.
 * @param {'L1' | 'L2' | 'L3'} decision.layer — слой, который ответил.
 * @param {string} decision.reason — почему выбран слой (короткая строка).
 * @param {number} decision.tokensSavedEstimate — экономия (≥ 0); у L1/L3 обязана быть 0.
 * @param {number} [decision.injectedTokens] — токены инъекции памяти в ход (≥ 0, по умолчанию 0).
 * @returns {{ layer: 'L1' | 'L2' | 'L3', reason: string, tokens_saved_estimate: number, injected_tokens: number }} записанный payload.
 */
export function recordRouteMetric(store, { layer, reason, tokensSavedEstimate, injectedTokens = 0 } = {}) {
  if (!store || typeof store.recordMetric !== 'function') {
    throw new TypeError('dsh-memory: recordRouteMetric нужен открытый store')
  }
  if (!ROUTE_LAYERS.includes(layer)) {
    throw new TypeError(`dsh-memory: layer должен быть ${ROUTE_LAYERS.join(' | ')}; получено ${JSON.stringify(layer)}`)
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new TypeError('dsh-memory: route.reason должен быть непустой строкой')
  }
  const saved = Number(tokensSavedEstimate)
  if (!Number.isFinite(saved) || saved < 0) {
    throw new TypeError('dsh-memory: tokens_saved_estimate должен быть числом ≥ 0')
  }
  if (layer !== 'L2' && Math.round(saved) > 0) {
    throw new TypeError('dsh-memory: экономия возможна только на L2 (L1 — расход, L3 — основная модель); savings у L1/L3 должен быть 0')
  }
  const injected = Number(injectedTokens)
  if (!Number.isFinite(injected) || injected < 0) {
    throw new TypeError('dsh-memory: injected_tokens должен быть числом ≥ 0')
  }

  const payload = {
    layer,
    reason: reason.trim(),
    tokens_saved_estimate: Math.round(saved),
    injected_tokens: Math.round(injected),
  }
  store.recordMetric('route', payload)
  return payload
}

/**
 * Записать событие `dispatch` (028): сколько подтем, какие роли, сколько
 * заняла каждая роль, стратегия, fallback и причина. Текст запроса/ответов не
 * пишется — только имена ролей и числа.
 *
 * @param {import('./store.js').MemoryStore} store — хранилище.
 * @param {object} event — данные диспетчера.
 * @param {number} event.subtopics — число подтем.
 * @param {string[]} [event.roles] — роли, участвовавшие в ходе.
 * @param {Record<string, number>} [event.durationsMs] — длительность по ролям.
 * @param {string} [event.strategy] — стратегия агрегации.
 * @param {boolean} [event.fallback] — ушёл ли ход на L3.
 * @param {string} [event.reason] — причина решения/fallback.
 * @param {number} [event.latencyMs] — общая длительность диспетчера.
 * @returns {object} записанный payload.
 */
export function recordDispatchMetric(store, {
  subtopics,
  roles = [],
  durationsMs = {},
  strategy = 'priority',
  fallback = false,
  reason = '',
  latencyMs = 0,
} = {}) {
  if (!store || typeof store.recordMetric !== 'function') {
    throw new TypeError('dsh-memory: recordDispatchMetric нужен открытый store')
  }
  const durations = {}
  for (const [role, value] of Object.entries(durationsMs ?? {})) {
    const number = Number(value)
    if (typeof role === 'string' && role.trim() !== '' && Number.isFinite(number) && number >= 0) {
      durations[role.trim()] = Math.round(number)
    }
  }
  const payload = {
    subtopics: Math.max(0, Math.trunc(Number(subtopics) || 0)),
    roles: [...new Set((Array.isArray(roles) ? roles : []).filter((role) => typeof role === 'string' && role.trim() !== '').map((role) => role.trim()))],
    durations_ms: durations,
    strategy: typeof strategy === 'string' && strategy.trim() !== '' ? strategy.trim() : 'priority',
    fallback: Boolean(fallback),
    reason: typeof reason === 'string' ? reason.trim().slice(0, 200) : '',
    latency_ms: Math.max(0, Math.round(Number(latencyMs) || 0)),
  }
  store.recordMetric('dispatch', payload)
  return payload
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
 * @returns {{ entries: number, by_status: { draft: number, verified: number, stale: number }, hit_rate: number, injected_tokens: number, tokens_saved_estimate: number, dispatch: { count: number, fallback_rate: number, p50_ms: number|null, p95_ms: number|null, by_role: Record<string, { count: number, p50_ms: number|null, p95_ms: number|null }> } }} сводка.
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
  for (const metric of searches) {
    const payload = metric.payload ?? {}
    const hits = Number(payload.hits)
    if (Number.isFinite(hits) && hits > 0) hitSearches += 1
  }

  // Семантика (решение диспетчера по 011): L1-инъекция — расход, а не
  // экономия, поэтому `tokens_saved_estimate` считается только по L2/L3
  // route-событиям (L2 вместо L3), а `injected_tokens` — суммарный расход на
  // инъекции памяти. Search-события экономию не формируют; в MVP сумма
  // savings = 0 до калибровки бенчмарком 015.
  const routes = store.listMetrics({ event: 'route' })
  let tokensSaved = 0
  let injected = 0
  for (const metric of routes) {
    const payload = metric.payload ?? {}
    const layer = payload.layer
    const saved = Number(payload.tokens_saved_estimate)
    if ((layer === 'L2' || layer === 'L3') && Number.isFinite(saved) && saved > 0) {
      tokensSaved += saved
    }
    const injectedTokens = Number(payload.injected_tokens)
    if (Number.isFinite(injectedTokens) && injectedTokens > 0) injected += injectedTokens
  }

  const dispatches = store.listMetrics({ event: 'dispatch' })
  let fallbackCount = 0
  const latencyValues = []
  const roleLatencies = new Map()
  for (const metric of dispatches) {
    const payload = metric.payload ?? {}
    if (payload.fallback === true) fallbackCount += 1
    const latency = Number(payload.latency_ms)
    if (Number.isFinite(latency) && latency >= 0) latencyValues.push(latency)
    const durations = payload.durations_ms
    if (durations !== null && typeof durations === 'object' && !Array.isArray(durations)) {
      for (const [role, value] of Object.entries(durations)) {
        const number = Number(value)
        if (!Number.isFinite(number) || number < 0) continue
        const list = roleLatencies.get(role) ?? []
        list.push(number)
        roleLatencies.set(role, list)
      }
    }
  }
  const byRole = {}
  for (const [role, values] of roleLatencies) {
    byRole[role] = {
      count: values.length,
      p50_ms: percentile(values, 0.5),
      p95_ms: percentile(values, 0.95),
    }
  }

  return {
    entries: store.countEntries(),
    by_status: byStatus,
    hit_rate: searches.length === 0 ? 0 : round(hitSearches / searches.length),
    injected_tokens: Math.round(injected),
    tokens_saved_estimate: Math.round(tokensSaved),
    dispatch: {
      count: dispatches.length,
      fallback_rate: dispatches.length === 0 ? 0 : round(fallbackCount / dispatches.length),
      p50_ms: percentile(latencyValues, 0.5),
      p95_ms: percentile(latencyValues, 0.95),
      by_role: byRole,
    },
  }
}

/**
 * Перцентиль (линейная интерполяция). Пустой список — `null`, чтобы stats не
 * выдавал 0 за «мгновенно».
 *
 * @param {number[]} values — значения.
 * @param {number} p — перцентиль 0..1.
 * @returns {number|null} значение.
 */
function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const position = (sorted.length - 1) * p
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return round(sorted[lower])
  return round(sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower))
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
