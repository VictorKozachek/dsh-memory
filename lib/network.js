/**
 * Политика сети для опционального пакета `dsh-memory-embeddings` (задача 021).
 *
 * Основной пакет `dsh-memory` не делает сетевых вызовов вообще (это проверяет
 * `test/trust-boundary.test.mjs`). Весь egress будущих эмбеддингов живёт в
 * отдельном бандле, и перед любым сетевым вызовом он обязан спросить
 * {@link networkAllowed}. `DSH_MEMORY_NO_NETWORK=1` (а также `true`/`on`/`yes`)
 * запрещает сеть целиком — включая локальный Ollama: явный флаг должен
 * означать «никакого egress», иначе его нельзя использовать в закрытом контуре
 * как гарантию.
 *
 * @module dsh-memory/network
 */

/** Имя переменной окружения, запрещающей сеть. */
export const NO_NETWORK_ENV = 'DSH_MEMORY_NO_NETWORK'

/** Значения, которые считаются «сеть запрещена». */
const DENY_VALUES = new Set(['1', 'true', 'on', 'yes'])

/**
 * Разрешена ли сеть в текущем окружении.
 *
 * @param {Record<string, string | undefined>} [env] — окружение.
 * @returns {boolean} false, если выставлен `DSH_MEMORY_NO_NETWORK`.
 */
export function networkAllowed(env = process.env) {
  const raw = env?.[NO_NETWORK_ENV]
  if (raw === undefined || String(raw).trim() === '') return true
  return !DENY_VALUES.has(String(raw).trim().toLowerCase())
}

/**
 * Проверить политику сети и бросить понятную ошибку, если egress запрещён.
 * Вызывается опциональным пакетом перед HTTP-запросом к провайдеру.
 *
 * @param {Record<string, string | undefined>} [env] — окружение.
 * @returns {void}
 */
export function assertNetworkAllowed(env = process.env) {
  if (!networkAllowed(env)) {
    throw new Error('dsh-memory-embeddings: сеть запрещена (DSH_MEMORY_NO_NETWORK); используется только локальный FTS5')
  }
}
