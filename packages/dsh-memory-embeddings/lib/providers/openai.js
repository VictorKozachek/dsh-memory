/**
 * OpenAI-совместимый провайдер эмбеддингов (задача 016).
 *
 * Ключ берётся только из `env[api_key_env]`, никогда не пишется в БД/логи и
 * редактируется в сообщениях об ошибках. `DSH_MEMORY_NO_NETWORK=1` запрещает
 * вызов до открытия соединения.
 *
 * @module dsh-memory-embeddings/providers/openai
 */

import { assertNetworkAllowed } from '../network.js'

/**
 * Создать провайдер.
 *
 * @param {object} options — параметры.
 * @param {string} options.base_url — база API (например, `https://api.openai.com/v1`).
 * @param {string} options.model — id модели.
 * @param {string} [options.api_key_env] — имя переменной с ключом.
 * @param {Record<string, string | undefined>} [options.env] — окружение.
 * @param {Function} [options.fetchImpl] — fetch (подмена в тестах).
 * @param {number} [options.timeout_ms] — таймаут.
 * @param {number} [options.max_retries] — повторы 429/5xx.
 * @param {number} [options.batch_size] — размер батча.
 * @returns {{ kind: 'openai-compatible', model: string, dim: number|null, embed: Function }} провайдер.
 */
export function createOpenAiProvider({
  base_url,
  model,
  api_key_env = 'DSH_MEMORY_EMBEDDINGS_API_KEY',
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeout_ms = 5_000,
  max_retries = 2,
  batch_size = 32,
} = {}) {
  const baseUrl = readBaseUrl(base_url)
  const modelId = requireText(model, 'model')
  const keyEnv = requireText(api_key_env, 'api_key_env')
  const apiKey = env?.[keyEnv]
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error(`dsh-memory-embeddings: ключ не задан в env ${keyEnv}; канал выключен, используется FTS5`)
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('dsh-memory-embeddings: нет fetch для openai-compatible провайдера')
  }
  const size = Number.isSafeInteger(batch_size) && batch_size > 0 ? batch_size : 32

  return {
    kind: 'openai-compatible',
    model: modelId,
    dim: null,
    async embed(texts) {
      assertNetworkAllowed(env)
      const vectors = []
      for (let offset = 0; offset < texts.length; offset += size) {
        vectors.push(...await requestBatch({
          baseUrl,
          model: modelId,
          apiKey,
          keyEnv,
          texts: texts.slice(offset, offset + size),
          fetchImpl,
          timeoutMs: timeout_ms,
          maxRetries: max_retries,
        }))
      }
      return { vectors, dim: vectors[0]?.length ?? 0 }
    },
  }
}

/** Проверить base_url: http(s), без query/fragment, нормализованный. */
function readBaseUrl(value) {
  const text = requireText(value, 'base_url')
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error(`dsh-memory-embeddings: base_url не URL: ${text}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('dsh-memory-embeddings: base_url должен быть http(s)')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`
}

/** Непустая строка. */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`dsh-memory-embeddings: ${field} обязателен`)
  }
  return value.trim()
}

/** Один батч с повторами 429/5xx. */
async function requestBatch({ baseUrl, model, apiKey, keyEnv, texts, fetchImpl, timeoutMs, maxRetries }) {
  let attempt = 0
  for (;;) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: texts }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`dsh-memory-embeddings: провайдер ответил ${response.status}: ${redact(body, apiKey)} (ключ из ${keyEnv})`)
      }
      const payload = await response.json()
      const data = Array.isArray(payload?.data) ? payload.data : []
      if (data.length !== texts.length) throw new Error('dsh-memory-embeddings: провайдер вернул неверное число векторов')
      return data.map((item, index) => toVector(item?.embedding, index))
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`dsh-memory-embeddings: таймаут провайдера ${timeoutMs} мс (ключ из ${keyEnv})`)
      if (!isRetryable(error) || attempt >= maxRetries) throw redactError(error, apiKey, keyEnv)
      attempt += 1
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Превратить ответ провайдера в Float32Array, проверив конечность. */
function toVector(value, index) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`dsh-memory-embeddings: пустой embedding в позиции ${index}`)
  const vector = Float32Array.from(value)
  for (const component of vector) {
    if (!Number.isFinite(component)) throw new Error(`dsh-memory-embeddings: нечисловой embedding в позиции ${index}`)
  }
  return vector
}

/** Ответ 429/5xx имеет смысл повторить. */
function isRetryable(error) {
  const message = error instanceof Error ? error.message : String(error)
  const match = /ответил (\d{3})/u.exec(message)
  return match === null ? false : match[1] === '429' || Number(match[1]) >= 500
}

/** Убрать ключ из строки. */
export function redact(text, secret) {
  const value = String(text ?? '')
  if (typeof secret !== 'string' || secret === '') return value
  return value.split(secret).join('***')
}

/** Ошибка без ключа в тексте. */
function redactError(error, apiKey, keyEnv) {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(redact(message, apiKey))
}
