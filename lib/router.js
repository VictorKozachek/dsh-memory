/**
 * Жёсткий роутер L2→L3 (задача 017).
 *
 * Точка входа: ход после L1 (память), когда нужен ответ модели. Роутер
 * спрашивает дешёвую L2 (пресет triage) и **жёстко** решает: если ответ
 * содержит уверенность не ниже `router.confidence_threshold` — ход
 * обслуживает L2, иначе вызывается L3 (основная модель). В отличие от мягкого
 * каскада 012, решение не «пробуем L2 и идём дальше по NO_ANSWER», а
 * детерминированный порог; при выключенном флаге (`router.enabled:false`,
 * дефолт) L2 не вызывается вовсе — поведение равно прямому L3.
 *
 * Стриминг: L2 в режиме роутинга буферизуется до решения (нельзя отдать
 * пользователю токены L2, а потом передумать и пойти в L3); токены L3
 * передаются в `onEvent({type:'token'})`. Отмена — внешний `signal`:
 * отменённый ход не идёт в L3. Таймаут L2 — `router.timeout_ms`, после него
 * fallback на L3; таймаут L3 пробрасывается. Логи — только слой/причина, без
 * текста запроса и ответа. Решение пишется в `metrics` как `route` (011).
 *
 * @module dsh-memory/router
 */

import { recordRouteMetric } from './metrics.js'

/** Дефолты жёсткого роутера. */
export const ROUTER_DEFAULTS = Object.freeze({
  enabled: false,
  confidence_threshold: 0.6,
  timeout_ms: 5_000,
})

/** Ошибка таймаута L2. */
export class RouterTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`dsh-memory: L2 не ответил за ${timeoutMs} мс`)
    this.name = 'RouterTimeoutError'
  }
}

/**
 * Собрать настройки роутера из конфига (разрешённого или сырого).
 *
 * @param {object} [config] — конфиг плагина.
 * @returns {{ enabled: boolean, confidence_threshold: number, timeout_ms: number }} настройки.
 */
export function resolveRouterConfig(config = {}) {
  const section = config?.router ?? {}
  const threshold = Number(section.confidence_threshold)
  const timeout = Number(section.timeout_ms)
  return {
    enabled: section.enabled === true,
    confidence_threshold: Number.isFinite(threshold) && threshold >= 0 && threshold <= 1
      ? threshold
      : ROUTER_DEFAULTS.confidence_threshold,
    timeout_ms: Number.isSafeInteger(timeout) && timeout > 0 ? timeout : ROUTER_DEFAULTS.timeout_ms,
  }
}

/**
 * Провести ход через жёсткий роутер.
 *
 * @param {object} options — параметры хода.
 * @param {string} options.query — запрос пользователя.
 * @param {{ l2?: Function, l3?: Function }} [options.providers] — провайдеры моделей.
 * @param {object} [options.config] — конфиг плагина (`router`).
 * @param {AbortSignal} [options.signal] — отмена хода.
 * @param {import('./store.js').MemoryStore} [options.store] — хранилище для `metrics`.
 * @param {(level: 'debug' | 'info' | 'warn', message: string) => void} [options.logger] — лог без текста запроса.
 * @param {(event: object) => void} [options.onEvent] — события `route`/`token`.
 * @returns {Promise<{ layer: 'L2' | 'L3', answer: string, confidence: number, reason: string, tokensSavedEstimate: number }>} ответ и решение.
 */
export async function routeTurn({
  query,
  providers = {},
  config = {},
  signal,
  store,
  logger = () => {},
  onEvent = () => {},
} = {}) {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new TypeError('dsh-memory: routeTurn ждёт непустой query')
  }
  if (typeof providers.l3 !== 'function') {
    throw new TypeError('dsh-memory: routeTurn нужен providers.l3 (основная модель)')
  }
  const settings = resolveRouterConfig(config)

  // Флаг выключен: L2 не вызывается, ход идёт прямо в L3 (нет регрессии).
  if (!settings.enabled) {
    // Выключенный флаг сохраняет прежнее поведение хода: прямой L3 без
    // router.timeout_ms (таймаут — часть контракта включённого роутера).
    onEvent({ type: 'route', layer: 'L3', reason: 'router disabled' })
    const answer = await callL3Direct(providers.l3, {
      query,
      reason: 'router disabled',
      onToken: (token) => emitToken(onEvent, 'L3', token),
    })
    recordRoute(store, { layer: 'L3', reason: 'router disabled', tokensSavedEstimate: 0 })
    logger('debug', 'router disabled: L3')
    return { layer: 'L3', answer: answer.answer, confidence: answer.confidence, reason: 'router disabled', tokensSavedEstimate: 0 }
  }

  if (typeof providers.l2 !== 'function') {
    onEvent({ type: 'route', layer: 'L3', reason: 'L2 unavailable' })
    const answer = await callL3WithTimeout(providers.l3, {
      query,
      reason: 'L2 unavailable',
      onToken: (token) => emitToken(onEvent, 'L3', token),
    }, { timeoutMs: settings.timeout_ms, outer: signal })
    recordRoute(store, { layer: 'L3', reason: 'L2 unavailable', tokensSavedEstimate: 0 })
    return { layer: 'L3', answer: answer.answer, confidence: answer.confidence, reason: 'L2 unavailable', tokensSavedEstimate: 0 }
  }

  // L2 буферизуется: токены не отдаём до решения.
  let reply = null
  let reason = 'confident'
  try {
    reply = normalizeReply(await callWithTimeout(
      (signalL2) => providers.l2({ query, signal: signalL2 }),
      settings.timeout_ms,
      signal,
    ))
  } catch (error) {
    if (isAbort(error) || signal?.aborted) {
      logger('info', 'router: ход отменён на L2')
      throw abortError()
    }
    reason = error instanceof RouterTimeoutError ? 'L2 timeout' : 'L2 error'
    logger('warn', `router: ${reason}`)
  }

  if (isConfident(reply, settings.confidence_threshold)) {
    const tokensSavedEstimate = nonNegative(reply.tokensSavedEstimate)
    recordRoute(store, { layer: 'L2', reason: 'confident', tokensSavedEstimate })
    logger('debug', `router: L2 (confidence ${reply.confidence})`)
    onEvent({ type: 'route', layer: 'L2', reason: 'confident', confidence: reply.confidence })
    return { layer: 'L2', answer: reply.answer, confidence: reply.confidence, reason: 'confident', tokensSavedEstimate }
  }

  if (reply === null) {
    // причина уже выставлена (timeout/error)
  } else if (reply.status === 'NO_ANSWER') {
    reason = 'L2 no answer'
  } else {
    reason = `L2 low confidence (${Number.isFinite(reply.confidence) ? reply.confidence : 'n/a'})`
  }

  onEvent({ type: 'route', layer: 'L3', reason })
  const answer = await callL3WithTimeout(providers.l3, {
    query,
    reason,
    onToken: (token) => emitToken(onEvent, 'L3', token),
  }, { timeoutMs: settings.timeout_ms, outer: signal })
  recordRoute(store, { layer: 'L3', reason, tokensSavedEstimate: 0 })
  logger('debug', `router: L3 (${reason})`)
  return { layer: 'L3', answer: answer.answer, confidence: answer.confidence, reason, tokensSavedEstimate: 0 }
}

/**
 * Вызвать L3 без таймаутов роутера (disabled-путь): сохраняется прежнее
 * поведение хода, отмена передаётся провайдеру как есть.
 *
 * @param {Function} provider — L3.
 * @param {object} input — аргументы.
 * @returns {Promise<{ answer: string, confidence: number }>} нормализованный ответ.
 */
async function callL3Direct(provider, input) {
  const reply = normalizeReply(await provider(input))
  if (!isAnswer(reply)) throw new Error('dsh-memory: L3 вернул пустой ответ')
  return reply
}

/**
 * Вызвать L3 с таймаутом и внешней отменой (жёсткий роутер не ждёт основную
 * модель бесконечно).
 *
 * @param {Function} provider — L3.
 * @param {object} input — аргументы.
 * @param {{ timeoutMs: number, outer?: AbortSignal }} options — таймаут/отмена.
 * @returns {Promise<{ answer: string, confidence: number }>} нормализованный ответ.
 */
async function callL3WithTimeout(provider, input, { timeoutMs, outer }) {
  const raw = await callWithTimeout(
    (signal) => provider({ ...input, signal }),
    timeoutMs,
    outer,
  )
  const reply = normalizeReply(raw)
  if (!isAnswer(reply)) throw new Error('dsh-memory: L3 вернул пустой ответ')
  return reply
}


/** Нормализовать ответ провайдера (строка/объект, контракт ANSWER|NO_ANSWER). */
function normalizeReply(reply) {
  if (typeof reply === 'string') {
    const value = reply.trim()
    if (value === '' || /^NO_ANSWER\b/iu.test(value)) return { status: 'NO_ANSWER', answer: '', confidence: 0 }
    // Голый маркер ANSWER — не текст ответа: у строки нет confidence, и
    // принимать её за уверенный ответ нельзя (уйдём на L3).
    if (/^ANSWER[.!?]*$/iu.test(value)) return { status: 'ANSWER', answer: '', confidence: 0 }
    return { status: 'ANSWER', answer: value, confidence: 1 }
  }
  if (reply === null || typeof reply !== 'object') return null
  const answer = typeof reply.answer === 'string' ? reply.answer.trim() : ''
  const confidence = Number(reply.confidence)
  if (reply.status === 'NO_ANSWER' || answer === '') {
    return { ...reply, status: 'NO_ANSWER', answer: '', confidence: Number.isFinite(confidence) ? confidence : 0 }
  }
  return {
    ...reply,
    status: 'ANSWER',
    answer,
    confidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : 0,
  }
}

/** Содержательный ответ и уверенность не ниже порога. */
function isConfident(reply, threshold) {
  return reply !== null && reply.status !== 'NO_ANSWER' && reply.answer.trim() !== ''
    && Number.isFinite(reply.confidence) && reply.confidence >= threshold
}

/** Ответ непустой. */
function isAnswer(reply) {
  return reply !== null && reply.status !== 'NO_ANSWER' && typeof reply.answer === 'string' && reply.answer.trim() !== ''
}

/** Число ≥ 0 или 0. */
function nonNegative(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}

/** Записать route-метрику, не ломая ход. */
function recordRoute(store, decision) {
  if (!store) return
  try {
    recordRouteMetric(store, decision)
  } catch {
    // метрика не должна ломать ход (011)
  }
}

/** Событие токена. */
function emitToken(onEvent, layer, token) {
  if (typeof token === 'string' && token !== '') onEvent({ type: 'token', layer, token })
}

/**
 * Вызвать L2 с таймаутом и внешней отменой.
 *
 * @param {(signal: AbortSignal) => Promise<unknown>} call — вызов.
 * @param {number} timeoutMs — таймаут.
 * @param {AbortSignal | undefined} outer — внешняя отмена.
 * @returns {Promise<unknown>} результат.
 */
async function callWithTimeout(call, timeoutMs, outer) {
  if (outer?.aborted) throw abortError()
  const controller = new AbortController()
  let timer
  let onOuterAbort
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new RouterTimeoutError(timeoutMs))
      reject(new RouterTimeoutError(timeoutMs))
    }, timeoutMs)
  })
  // Отмена должна завершать гонку сразу, даже если провайдер игнорирует signal.
  const aborted = new Promise((_, reject) => {
    onOuterAbort = () => {
      controller.abort(abortError())
      reject(abortError())
    }
    outer?.addEventListener('abort', onOuterAbort, { once: true })
  })
  try {
    return await Promise.race([call(controller.signal), timeout, aborted])
  } catch (error) {
    if (outer?.aborted) throw abortError()
    // Провайдер мог отреагировать на abort таймаута AbortError'ом: снаружи это
    // всё равно таймаут, а не отмена хода.
    if (controller.signal.aborted) throw new RouterTimeoutError(timeoutMs)
    throw error
  } finally {
    clearTimeout(timer)
    if (onOuterAbort !== undefined) outer?.removeEventListener('abort', onOuterAbort)
  }
}
/** Похоже ли исключение на отмену. */
function isAbort(error) {
  return error?.name === 'AbortError'
}

/** AbortError. */
function abortError() {
  const error = new Error('dsh-memory: ход отменён')
  error.name = 'AbortError'
  return error
}
