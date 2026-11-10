/**
 * Локальная ONNX/WASM-модель эмбеддингов (задача 016).
 *
 * Нейросетевая модель и рантайм не входят в пакет (это отдельные артефакты и
 * опциональные зависимости). Провайдер принимает готовый `embedder` (тесты,
 * кастомная интеграция) или лениво загружает `@xenova/transformers`, если он
 * установлен рядом. Сеть для самой модели не нужна, если модель уже на диске;
 * скачивание модели — отдельное явное действие, а не скрытый egress.
 *
 * @module dsh-memory-embeddings/providers/local-onnx
 */

/**
 * Создать локальный ONNX-провайдер.
 *
 * @param {object} [options] — параметры.
 * @param {string} [options.model] — id/путь модели.
 * @param {string} [options.model_path] — локальный путь модели (приоритетнее id).
 * @param {number} [options.dim] — ожидаемая размерность (проверяется).
 * @param {Function} [options.embedder] — готовая функция `(texts) => Promise<Float32Array[]>`.
 * @returns {{ kind: 'local-onnx', model: string, dim: number, embed: Function }} провайдер.
 */
export function createLocalOnnxProvider({ model = 'Xenova/all-MiniLM-L6-v2', model_path = '', dim = 384, embedder } = {}) {
  let resolved = embedder
  const source = model_path || model
  return {
    kind: 'local-onnx',
    model,
    dim,
    async embed(texts) {
      if (typeof resolved !== 'function') resolved = await loadTransformersEmbedder(source)
      const vectors = await resolved(texts)
      if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        throw new Error('dsh-memory-embeddings: локальная модель вернула неверное число векторов')
      }
      return {
        vectors: vectors.map((vector) => {
          const output = Float32Array.from(vector ?? [])
          if (output.length === 0) throw new Error('dsh-memory-embeddings: локальная модель вернула пустой вектор')
          return output
        }),
        dim: dim || vectors[0]?.length || 0,
      }
    },
  }
}

/**
 * Лениво загрузить `@xenova/transformers` и собрать embedder. Зависимость
 * опциональна: без неё — понятная ошибка, плагин остаётся на FTS5.
 *
 * @param {string} source — путь/имя модели.
 * @returns {Promise<(texts: string[]) => Promise<Float32Array[]>>} embedder.
 */
async function loadTransformersEmbedder(source) {
  let transformers
  try {
    transformers = await import('@xenova/transformers')
  } catch {
    throw new Error('dsh-memory-embeddings: local-onnx требует @xenova/transformers и локальную модель; канал выключен, используется FTS5')
  }
  const pipeline = transformers.pipeline ?? transformers.default?.pipeline
  if (typeof pipeline !== 'function') {
    throw new Error('dsh-memory-embeddings: @xenova/transformers не экспортирует pipeline')
  }
  const extractor = await pipeline('feature-extraction', source)
  return async (texts) => {
    const output = await extractor(texts, { pooling: 'mean', normalize: true })
    const data = output?.data ?? output
    if (!Array.isArray(data) && !(data instanceof Float32Array)) {
      throw new Error('dsh-memory-embeddings: локальная модель вернула неожиданный формат')
    }
    const values = Array.from(data)
    const size = Math.max(1, Math.floor(values.length / texts.length))
    return texts.map((_, index) => Float32Array.from(values.slice(index * size, (index + 1) * size)))
  }
}
