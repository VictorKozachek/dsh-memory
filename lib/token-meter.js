/**
 * Адаптер к опциональному `dsh-token-meter` (задача 011).
 *
 * В DSH `ctx.tokenMeter` — сервис измерения токенов с двумя операциями:
 * `measure(session)` и `estimateMessage(message)`. Канала публикации метрик у
 * него нет (он регистрирует read-only проекции `tokenUsage`/
 * `contextPressure`/`contextBreakdown` и ничего не принимает), поэтому
 * интеграция честно устроена так:
 * - если сервис доступен, оценка токенов идёт через `estimateMessage` — та же
 *   арифметика, что у token-meter (единственный авторитетный счётчик);
 * - если сервиса нет, используется локальная эвристика `estimateTokens` —
 *   относительно token-meter это no-op: ни вызовов, ни подписок;
 * - `publish(metric)` — всегда no-op (false) на реальном DSH: публиковать
 *   метрику в token-meter некуда. Метод оставлен, чтобы вызывающий код не
 *   разрастался условиями, и документирует ограничение.
 *
 * @module dsh-memory/token-meter
 */

import { randomUUID } from 'node:crypto'

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
        // Полная форма Message (id/role/content/source), как в dsh-llm: контракт
        // estimateMessage типизирован Message, хотя реализация читает content.
        const tokens = tokenMeter.estimateMessage({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: value }],
          source: { kind: 'plugin', plugin: 'dsh-memory' },
        })
        return Number.isFinite(tokens) && tokens >= 0 ? Math.round(tokens) : estimateTokens(value)
      } catch {
        return estimateTokens(value)
      }
    },

    /**
     * Публикация в token-meter на реальном DSH — no-op: сервис только измеряет
     * (`measure`/`estimateMessage`) и не принимает метрики. Метрики памяти
     * пишутся в собственную таблицу `metrics`; token-meter используется как
     * авторитетный оценщик в `estimate`.
     *
     * @param {object} _metric — метрика (не используется).
     * @returns {boolean} всегда false.
     */
    publish(_metric) {
      return false
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
