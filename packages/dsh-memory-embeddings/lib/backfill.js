/**
 * Бэкфилл векторов (задача 016): досчитать embeddings для записей, у которых
 * их нет. Работает и синхронным локальным провайдером, и async API-провайдером;
 * сбой одного батча не прерывает остальные.
 *
 * @module dsh-memory-embeddings/backfill
 */

/**
 * Досчитать недостающие векторы.
 *
 * @param {object} options — параметры.
 * @param {import('@vkozachek/dsh-memory').MemoryStore} options.store — открытое хранилище.
 * @param {{ embed: Function, model: string }} options.provider — провайдер.
 * @param {string} [options.model] — id модели (по умолчанию provider.model).
 * @param {number} [options.batch_size] — размер батча.
 * @param {(level: 'warn' | 'info', message: string) => void} [options.log] — лог.
 * @returns {Promise<{ embedded: number, failed: number }>} итог.
 */
export async function backfillEmbeddings({ store, provider, model = provider.model, batch_size = 32, log = () => {} } = {}) {
  if (!store || typeof store.listEntriesWithoutEmbedding !== 'function' || typeof store.upsertEmbedding !== 'function') {
    throw new TypeError('dsh-memory-embeddings: backfill нужен открытый MemoryStore')
  }
  if (!provider || typeof provider.embed !== 'function') {
    throw new TypeError('dsh-memory-embeddings: backfill нужен провайдер с embed')
  }
  const size = Number.isSafeInteger(batch_size) && batch_size > 0 ? batch_size : 32
  const rows = store.listEntriesWithoutEmbedding(model)
  let embedded = 0
  let failed = 0
  if (rows.length > 0) log('info', `embeddings: досчёт векторов ${rows.length} записей (модель ${model})`)
  for (let offset = 0; offset < rows.length; offset += size) {
    const batch = rows.slice(offset, offset + size)
    try {
      const { vectors, dim } = await provider.embed(batch.map((row) => `${row.title}\n${row.text}`))
      if (!Array.isArray(vectors) || vectors.length !== batch.length) {
        throw new Error('провайдер вернул неверное число векторов')
      }
      for (const [index, row] of batch.entries()) {
        const vector = vectors[index]
        if (dim !== undefined && vector.length !== dim) throw new Error('провайдер вернул вектор неверной размерности')
        store.upsertEmbedding({ entryId: row.id, model, vector })
        embedded += 1
      }
    } catch (error) {
      failed += batch.length
      log('warn', `embeddings: батч ${offset / size + 1} не посчитан: ${error instanceof Error ? error.message : String(error)}`)
    }
    log('info', `embeddings: прогресс ${Math.min(offset + size, rows.length)}/${rows.length}`)
  }
  if (rows.length > 0) log('info', `embeddings: досчёт завершён (векторов ${embedded}, ошибок ${failed})`)
  return { embedded, failed }
}
