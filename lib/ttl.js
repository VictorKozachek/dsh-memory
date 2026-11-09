/**
 * TTL записей памяти (задача 006, спека §7).
 *
 * Срок жизни зависит от `kind`: «решения» (ADR) живут дольше фактов, ответы —
 * меньше всех. TTL применяется **при выборке**: `memory.search` передаёт в
 * хранилище отсечки `expiresBefore`, и просроченная запись не попадает в
 * выдачу (в БД она не переписывается — ленивое истечение, статус не меняется).
 *
 * Для `doc` и `code-note` TTL нет: документация и заметки живут до
 * переиндексации/инвалидации.
 *
 * @module dsh-memory/ttl
 */

/** Сколько дней живёт запись по `kind` (спека §7). */
export const TTL_DAYS = Object.freeze({
  decision: 180,
  fact: 60,
  answer: 30,
})

/** Миллисекунд в сутках. */
const DAY_MS = 24 * 60 * 60 * 1_000

/**
 * TTL конкретного типа записи.
 *
 * @param {string} kind — тип записи.
 * @returns {number | undefined} дни или `undefined`, если TTL нет.
 */
export function ttlDaysFor(kind) {
  return Object.hasOwn(TTL_DAYS, kind) ? TTL_DAYS[kind] : undefined
}

/**
 * Отсечки для SQL-фильтра: для каждого типа — момент, раньше которого запись
 * уже просрочена (`created_at` должен быть больше отсечки).
 *
 * @param {number} now — текущее время, мс.
 * @returns {Record<string, number>} `kind` → cutoff (мс).
 */
export function ttlCutoffs(now = Date.now()) {
  return Object.fromEntries(
    Object.entries(TTL_DAYS).map(([kind, days]) => [kind, now - days * DAY_MS]),
  )
}

/**
 * Просрочена ли запись. Считается от `created_at` (как `days_since_created` в
 * метриках верификации); `doc`/`code-note` не протухают.
 *
 * @param {{ kind?: string, created_at?: number }} entry — строка записи.
 * @param {number} [now] — текущее время, мс.
 * @returns {boolean} true, если запись просрочена.
 */
export function isExpired(entry, now = Date.now()) {
  const days = ttlDaysFor(entry?.kind)
  if (days === undefined) return false
  const createdAt = Number(entry?.created_at)
  return Number.isFinite(createdAt) && now - createdAt > days * DAY_MS
}
