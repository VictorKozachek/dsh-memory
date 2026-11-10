/**
 * Синхронный канал гибридного поиска (задача 016): brute-force косинус по
 * векторам в SQLite BLOB. Канал отдаёт `[{ id, score }]`, основной пакет
 * сливает его с FTS5 через reciprocal rank fusion.
 *
 * @module dsh-memory-embeddings/channel
 */

/**
 * Косинус двух векторов.
 *
 * @param {Float32Array} left — вектор.
 * @param {Float32Array} right — вектор.
 * @returns {number} косинус (-1..1); 0 при нулевом векторе.
 */
export function cosineSimilarity(left, right) {
  if (!left || !right || left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}

/**
 * Создать канал для синхронного локального провайдера.
 *
 * @param {object} options — параметры.
 * @param {import('dsh-memory').MemoryStore} options.store — хранилище.
 * @param {{ embedOne: (text: string) => Float32Array, model: string }} options.provider — локальный провайдер.
 * @param {string} [options.model] — id модели.
 * @param {number} [options.weight] — вес канала в RRF.
 * @returns {{ name: string, weight: number, search: Function }} канал.
 */
export function createLocalChannel({ store, provider, model = provider.model, weight = 0.5 } = {}) {
  return {
    name: 'embeddings',
    weight,
    /**
     * Найти ближайшие записи по косинусу.
     *
     * @param {{ query: string, limit?: number }} input — запрос.
     * @returns {Array<{ id: number, score: number }>} кандидаты по убыванию.
     */
    search({ query, limit = 20 } = {}) {
      if (typeof query !== 'string' || query.trim() === '') return []
      // Локальный провайдер синхронный: досчитываем отсутствующие векторы прямо
      // перед поиском, чтобы канал работал для любого воркспейса/сессии, а не
      // только для того, который был открыт при загрузке плагина.
      for (const row of store.listEntriesWithoutEmbedding(model)) {
        store.upsertEmbedding({
          entryId: row.id,
          model,
          vector: provider.embedOne(`${row.title}\n${row.text}`),
        })
      }
      const queryVector = provider.embedOne(query)
      return store.listEmbeddings(model)
        .map((row) => ({ id: row.entryId, score: cosineSimilarity(queryVector, row.vector) }))
        .filter((row) => row.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
    },
  }
}
