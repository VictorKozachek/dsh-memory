/**
 * Решения каскада → `metrics` (задача 011).
 *
 * Каскад (010/012) выбирает слой L1/L2/L3 и пишет событие `route` с причиной,
 * оценкой экономии и расходом на инъекцию. Семантика (решение диспетчера по
 * 011): L1-инъекция — это расход, поэтому у L1 `tokens_saved_estimate = 0`, а
 * токены блока идут в `injected_tokens`; экономия появляется только на L2
 * вместо L3. Если доступен `dsh-token-meter`, оценка текста считается его
 * `estimateMessage` (у сервиса нет канала публикации, поэтому `published`
 * всегда false — метрика живёт в собственной таблице `metrics`); без сервиса —
 * локальная эвристика (см. `lib/token-meter.js`).
 *
 * @module dsh-memory/route
 */

import { recordRouteMetric } from './metrics.js'
import { createTokenMeterAdapter } from './token-meter.js'

/**
 * Создать репортёр решений каскада для одного хранилища.
 *
 * @param {import('./store.js').MemoryStore} store — открытое хранилище namespace.
 * @param {{ tokenMeter?: object }} [options] — опциональный `ctx.tokenMeter`.
 * @returns {{ available: boolean, record: (decision: object) => { layer: string, reason: string, tokens_saved_estimate: number, injected_tokens: number, published: boolean } }} репортёр.
 */
export function createRouteReporter(store, { tokenMeter } = {}) {
  const adapter = createTokenMeterAdapter(tokenMeter)

  return {
    /** Доступен ли token-meter (иначе оценка локальная и публикация — no-op). */
    available: adapter.available,

    /**
     * Записать решение каскада.
     *
     * @param {object} decision — решение.
     * @param {'L1' | 'L2' | 'L3'} decision.layer — слой, который ответил.
     * @param {string} decision.reason — причина выбора.
     * @param {number} [decision.tokensSavedEstimate] — готовая оценка экономии; у L1 по умолчанию 0.
     * @param {number} [decision.injectedTokens] — готовый расход на инъекцию; у L1 по умолчанию оценка `text`.
     * @param {string} [decision.text] — текст, который надо оценить, если оценка не задана.
     * @returns {{ layer: string, reason: string, tokens_saved_estimate: number, injected_tokens: number, published: boolean }} записанное событие и факт публикации в token-meter (на реальном DSH всегда false).
     */
    record(decision = {}) {
      const { layer, reason, tokensSavedEstimate, injectedTokens, text } = decision
      const estimate = text !== undefined ? adapter.estimate(text) : 0
      // L1-инъекция — расход: savings 0, injected_tokens — токены блока.
      const saved = tokensSavedEstimate !== undefined
        ? tokensSavedEstimate
        : layer === 'L1' ? 0 : estimate
      const injected = injectedTokens !== undefined
        ? injectedTokens
        : layer === 'L1' ? estimate : 0

      const payload = recordRouteMetric(store, {
        layer,
        reason,
        tokensSavedEstimate: saved,
        injectedTokens: injected,
      })
      const published = adapter.publish({ event: 'route', ...payload })
      return { ...payload, published }
    },
  }
}
