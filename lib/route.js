/**
 * Решения каскада → `metrics` (задача 011).
 *
 * Каскад (010/012) выбирает слой L1/L2/L3 и пишет событие `route` с причиной и
 * оценкой сэкономленных токенов. Здесь — тонкая обвязка: если доступен
 * `dsh-token-meter`, оценка текста-ответа считается его `estimateMessage` и
 * метрика (при наличии у сервиса `publish`/`record`) публикуется туда; без
 * сервиса — локальная эвристика и no-op (см. `lib/token-meter.js`).
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
 * @returns {{ available: boolean, record: (decision: object) => { layer: string, reason: string, tokens_saved_estimate: number, published: boolean } }} репортёр.
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
     * @param {number} [decision.tokensSavedEstimate] — готовая оценка экономии.
     * @param {string} [decision.text] — текст, который надо оценить, если оценка не задана.
     * @returns {{ layer: string, reason: string, tokens_saved_estimate: number, published: boolean }} записанное событие и факт публикации в token-meter.
     */
    record(decision = {}) {
      const { layer, reason, tokensSavedEstimate, text } = decision
      const estimate = tokensSavedEstimate !== undefined
        ? tokensSavedEstimate
        : text !== undefined ? adapter.estimate(text) : 0

      const payload = recordRouteMetric(store, { layer, reason, tokensSavedEstimate: estimate })
      const published = adapter.publish({ event: 'route', ...payload })
      return { ...payload, published }
    },
  }
}
