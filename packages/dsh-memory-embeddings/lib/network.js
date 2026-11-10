/**
 * Политика сети опционального пакета (задача 016).
 *
 * Основной `dsh-memory` не содержит сетевого кода. Здесь — единственное место,
 * где пакет спрашивает разрешение на egress. `DSH_MEMORY_NO_NETWORK=1`
 * запрещает любые сетевые вызовы, включая localhost (Ollama): строгий режим
 * должен означать «никакого сетевого стека».
 *
 * @module dsh-memory-embeddings/network
 */

/** Имя переменной окружения, запрещающей сеть. */
export const NO_NETWORK_ENV = 'DSH_MEMORY_NO_NETWORK'

const DENY_VALUES = new Set(['1', 'true', 'on', 'yes'])

/**
 * Разрешена ли сеть.
 *
 * @param {Record<string, string | undefined>} [env] — окружение.
 * @returns {boolean} false при `DSH_MEMORY_NO_NETWORK`.
 */
export function networkAllowed(env = process.env) {
  const raw = env?.[NO_NETWORK_ENV]
  if (raw === undefined || String(raw).trim() === '') return true
  return !DENY_VALUES.has(String(raw).trim().toLowerCase())
}

/**
 * Бросить понятную ошибку, если egress запрещён.
 *
 * @param {Record<string, string | undefined>} [env] — окружение.
 * @returns {void}
 */
export function assertNetworkAllowed(env = process.env) {
  if (!networkAllowed(env)) {
    throw new Error('dsh-memory-embeddings: сеть запрещена (DSH_MEMORY_NO_NETWORK); используется только локальный FTS5')
  }
}
