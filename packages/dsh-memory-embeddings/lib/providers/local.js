/**
 * Локальный офлайн-эмбеддер (задача 016): детерминированные хэшированные
 * признаки слов и триграмм. Не требует сети, ключей, зависимостей и модели на
 * диске — это базовая реализация «локальные эмбеддинги»; нейросетевая локальная
 * модель (ONNX/WASM) остаётся открытым вопросом 021/016.
 *
 * Вектор L2-нормализован, поэтому косинус — обычное скалярное произведение.
 *
 * @module dsh-memory-embeddings/providers/local
 */

/** Размерность по умолчанию. */
export const LOCAL_DIM = 128

/**
 * Посчитать локальный вектор текста.
 *
 * @param {string} text — текст.
 * @param {{ dim?: number }} [options] — размерность.
 * @returns {Float32Array} нормализованный вектор.
 */
export function embedLocal(text, { dim = LOCAL_DIM } = {}) {
  const size = Number.isSafeInteger(dim) && dim > 0 ? dim : LOCAL_DIM
  const values = new Float32Array(size)
  const tokens = String(text ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
  for (const token of tokens) {
    for (const feature of featuresFor(token)) {
      const hash = fnv1a(feature)
      const index = hash % size
      values[index] += (hash & 1) === 1 ? 1 : -1
    }
  }
  let norm = 0
  for (const value of values) norm += value * value
  norm = Math.sqrt(norm)
  if (norm > 0) for (let index = 0; index < size; index += 1) values[index] /= norm
  return values
}

/**
 * Создать локальный провайдер (синхронный: нужен каналу поиска без async).
 *
 * @param {{ dim?: number }} [options] — размерность.
 * @returns {{ kind: 'local', model: string, dim: number, embed: (texts: string[]) => { vectors: Float32Array[], dim: number }, embedOne: (text: string) => Float32Array }} провайдер.
 */
export function createLocalProvider({ dim = LOCAL_DIM, model = 'local-hash-128' } = {}) {
  return {
    kind: 'local',
    model,
    dim,
    embed(texts) {
      return { vectors: texts.map((text) => embedLocal(text, { dim })), dim }
    },
    embedOne(text) {
      return embedLocal(text, { dim })
    },
  }
}

/** FNV-1a 32-битный хэш. */
function fnv1a(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** Признаки слова: само слово и его символьные триграммы. */
function featuresFor(token) {
  const features = [token]
  const chars = [...token]
  for (let index = 0; index + 3 <= chars.length; index += 1) {
    features.push(chars.slice(index, index + 3).join(''))
  }
  return features
}
