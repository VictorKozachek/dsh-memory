/**
 * Адаптер к опциональному `dsh-token-meter` (задача 011).
 *
 * В DSH `ctx.tokenMeter` — это сервис измерения токенов (`measure(session)`,
 * `estimateMessage(message)`), а не хранилище метрик: «публиковать» события
 * ему некуда. Поэтому интеграция устроена так:
 * - если сервис доступен, оценка токенов идёт через `estimateMessage` — та же
 *   арифметика, что у token-meter (он единственный авторитетный счётчик);
 * - если сервиса нет, используется локальная эвристика `estimateTokens` —
 *   относительно token-meter это no-op: ни вызовов, ни подписок;
 * - `publish(metric)` — forward-compatible: если у сервиса появится
 *   `publish`/`record`, метрика уйдёт туда; без сервиса или без такого метода
 *   это no-op (false), ошибки глотаются.
 *
 * @module dsh-memory/token-meter
 */

import { estimateTokens } from './indexer.js'

/**
 * Создать адаптер оценки/публикации поверх (возможно, отсутствующего) token-meter.
 *
 * @param {object | undefined | null} tokenMeter — сервис `ctx.tokenMeter` (duck-typed).
 * @returns {{ available: boolean, estimate: (text: string) => number, publish: (metric: object) => boolean }} адаптер.
 */
export function createTokenMeterAdapter(tokenMeter) {
  const canEstimate = Boolean(tokenMeter && typeof tokenMeter.estimateMessage === 'function')

  return {
    available: canEstimate,

    /**
     * Оценить токены текста: token-meter, если доступен, иначе локальная
     * эвристика. Ошибка сервиса не должна ломать вызывающий инструмент.
     *
     * @param {string} text — текст (например, блок памяти).
     * @returns {number} оценка токенов (целое ≥ 0).
     */
    estimate(text) {
      const value = String(text ?? '')
      if (!canEstimate) return estimateTokens(value)
      try {
        const tokens = tokenMeter.estimateMessage({ content: [{ type: 'text', text: value }] })
        return Number.isFinite(tokens) && tokens >= 0 ? Math.round(tokens) : estimateTokens(value)
      } catch {
        return estimateTokens(value)
      }
    },

    /**
     * Опубликовать метрику в token-meter, если он умеет `publish`/`record`.
     *
     * @param {object} metric — метрика (например, route payload).
     * @returns {boolean} true, если сервис принял метрику.
     */
    publish(metric) {
      if (!canEstimate) return false
      const publish = typeof tokenMeter.publish === 'function'
        ? tokenMeter.publish
        : typeof tokenMeter.record === 'function' ? tokenMeter.record : undefined
      if (typeof publish !== 'function') return false
      try {
        publish.call(tokenMeter, metric)
        return true
      } catch {
        return false
      }
    },
  }
}

/**
 * Взять `ctx.tokenMeter`, если он есть, не требуя его (optional service).
 *
 * @param {object | undefined} ctx — контекст cordis.
 * @returns {object | undefined} сервис или undefined.
 */
export function optionalTokenMeter(ctx) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get('tokenMeter', false) ?? undefined
    return ctx?.tokenMeter ?? undefined
  } catch {
    return undefined
  }
}
