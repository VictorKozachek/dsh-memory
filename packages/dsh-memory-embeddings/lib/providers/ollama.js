/**
 * Ollama-провайдер локальных эмбеддингов (задача 016): HTTP к локальному
 * Ollama. Считается «локальной моделью», но `DSH_MEMORY_NO_NETWORK=1` запрещает
 * и его: строгий режим не делает исключений для localhost.
 *
 * @module dsh-memory-embeddings/providers/ollama
 */

import { assertNetworkAllowed } from '../network.js'

/** Дефолтный адрес Ollama. */
export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434'

/**
 * Создать Ollama-провайдер.
 *
 * @param {object} options — параметры.
 * @param {string} [options.base_url] — адрес (по умолчанию localhost:11434).
 * @param {string} options.model — id модели.
 * @param {Record<string, string | undefined>} [options.env] — окружение.
 * @param {Function} [options.fetchImpl] — fetch (подмена в тестах).
 * @param {number} [options.timeout_ms] — таймаут одного запроса.
 * @param {number} [options.batch_size] — размер батча (Ollama принимает по одному).
 * @returns {{ kind: 'ollama', model: string, dim: number|null, embed: Function }} провайдер.
 */
export function createOllamaProvider({
  base_url = OLLAMA_BASE_URL,
  model,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeout_ms = 5_000,
  batch_size = 32,
} = {}) {
  if (typeof model !== 'string' || model.trim() === '') throw new Error('dsh-memory-embeddings: model обязателен')
  if (typeof fetchImpl !== 'function') throw new Error('dsh-memory-embeddings: нет fetch для ollama провайдера')
  const base = new URL(base_url).origin
  const size = Number.isSafeInteger(batch_size) && batch_size > 0 ? batch_size : 32

  return {
    kind: 'ollama',
    model: model.trim(),
    dim: null,
    async embed(texts) {
      assertNetworkAllowed(env)
      const vectors = []
      for (let offset = 0; offset < texts.length; offset += size) {
        const batch = texts.slice(offset, offset + size)
        for (const text of batch) {
          const vector = await requestOne({ base, model: model.trim(), text, fetchImpl, timeoutMs: timeout_ms })
          vectors.push(vector)
        }
      }
      return { vectors, dim: vectors[0]?.length ?? 0 }
    },
  }
}

/** Один запрос `/api/embeddings`. */
async function requestOne({ base, model, text, fetchImpl, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${base}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`dsh-memory-embeddings: Ollama ответила ${response.status}`)
    const payload = await response.json()
    if (!Array.isArray(payload?.embedding) || payload.embedding.length === 0) {
      throw new Error('dsh-memory-embeddings: Ollama вернула пустой embedding')
    }
    return Float32Array.from(payload.embedding)
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`dsh-memory-embeddings: таймаут Ollama ${timeoutMs} мс`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}
