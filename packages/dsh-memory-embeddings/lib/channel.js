/**
 * Каналы гибридного поиска (задача 016): brute-force косинус по векторам в
 * SQLite BLOB. Канал всегда работает с `store`, который передал основной
 * `memory.search`, а не с замыканием, иначе id из чужого namespace могли бы
 * резолвиться в текущий.
 *
 * - {@link createLocalChannel} — синхронный канал для локального провайдера;
 * - {@link createAsyncChannel} — канал для API/Ollama: перед поиском досчитывает
 *   векторы и эмбеддинг запроса (используется `searchMemoryAsync`/hook).
 *
 * @module dsh-memory-embeddings/channel
 */

import { backfillEmbeddings } from './backfill.js'

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
 * Создать синхронный канал для локального провайдера.
 *
 * @param {object} options — параметры.
 * @param {{ embedOne: (text: string) => Float32Array, model: string }} options.provider — локальный провайдер.
 * @param {string} [options.model] — id модели.
 * @param {number} [options.weight] — вес канала в RRF.
 * @returns {{ name: string, weight: number, search: Function }} канал.
 */
export function createLocalChannel({ provider, model = provider.model, weight = 0.5 } = {}) {
  return {
    name: 'embeddings',
    weight,
    /**
     * @param {{ store: import('dsh-memory').MemoryStore, query: string, limit?: number }} input — запрос и хранилище.
     * @returns {Array<{ id: number, score: number }>} кандидаты по убыванию.
     */
    search({ store, query, limit = 20 } = {}) {
      if (!store || typeof store.listEmbeddings !== 'function' || typeof query !== 'string' || query.trim() === '') return []
      // Локальный провайдер синхронный: досчитываем отсутствующие векторы прямо
      // перед поиском, чтобы канал работал для любого воркспейса/сессии.
      for (const row of store.listEntriesWithoutEmbedding(model)) {
        store.upsertEmbedding({
          entryId: row.id,
          model,
          vector: provider.embedOne(`${row.title}\n${row.text}`),
        })
      }
      return nearestByCosine(store, provider.embedOne(query), model, limit)
    },
  }
}

/**
 * Создать асинхронный канал для API/Ollama: векторы досчитываются батчами,
 * эмбеддинг запроса считается через провайдер. Основной пакет вызывает его
 * через `searchMemoryAsync`/`buildMemoryBlockAsync`.
 *
 * @param {object} options — параметры.
 * @param {{ embed: (texts: string[]) => Promise<{ vectors: Float32Array[] }>, model: string }} options.provider — async-провайдер.
 * @param {string} [options.model] — id модели.
 * @param {number} [options.weight] — вес в RRF.
 * @param {number} [options.batch_size] — размер батча бэкфилла.
 * @param {boolean} [options.backfill] — досчитывать векторы перед поиском (по умолчанию да).
 * @param {(level: string, message: string) => void} [options.log] — лог.
 * @returns {{ name: string, weight: number, search: Function }} асинхронный канал.
 */
export function createAsyncChannel({
  provider,
  model = provider.model,
  weight = 0.5,
  batch_size = 32,
  backfill = true,
  log = () => {},
} = {}) {
  const prepared = new WeakSet()
  return {
    name: 'embeddings',
    weight,
    async search({ store, query, limit = 20 } = {}) {
      if (!store || typeof store.listEmbeddings !== 'function' || typeof query !== 'string' || query.trim() === '') return []
      if (backfill && !prepared.has(store)) {
        prepared.add(store)
        await backfillEmbeddings({ store, provider, model, batch_size, log })
      }
      const { vectors } = await provider.embed([query])
      const queryVector = vectors?.[0]
      if (!(queryVector instanceof Float32Array) || queryVector.length === 0) return []
      return nearestByCosine(store, queryVector, model, limit)
    },
  }
}

/** Brute-force косинус по векторам выбранной модели в переданном store. */
function nearestByCosine(store, queryVector, model, limit) {
  return store.listEmbeddings(model)
    .map((row) => ({ id: row.entryId, score: cosineSimilarity(queryVector, row.vector) }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
}
