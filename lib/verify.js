/**
 * `memory.verify` (задача 006): подтвердить `draft`-запись и перевести её в
 * `verified`.
 *
 * Правила (спека §5.3, §7):
 * - подтверждение обязательно: `verified_by` — непустая строка (сессия
 *   ревьювера/тестировщика или человек);
 * - по умолчанию требуется провенанс (`verify.require_source_for_verified`):
 *   `source_path`/`source_ref` или хотя бы один источник в `entry_sources`; без
 *   источника verify отказывает (опция `requireSource: false` снимает это
 *   правило — например, для ручного подтверждения человеком);
 * - `stale`-запись верифицировать нельзя: сначала знание надо перезаписать;
 * - `verified` идемпотентен: повторный verify уже подтверждённой записи
 *   возвращает `{ id, status: "verified" }` и ничего не меняет.
 *
 * `verified_by` не хранится в схеме `entries` (§5.1 колонки не содержит):
 * подтверждение — это допуск к переходу статуса, след остаётся в карточке
 * задачи/метриках, а поле `updated_at` фиксирует время. Колонка появится
 * отдельной миграцией, если понадобится аудит.
 *
 * @module dsh-memory/verify
 */

import { recordVerifyMetric } from './metrics.js'

/**
 * Перевести запись `draft` → `verified`.
 *
 * @param {import('./store.js').MemoryStore} store — открытое хранилище namespace.
 * @param {object} input — параметры подтверждения.
 * @param {number} input.id — идентификатор записи.
 * @param {string} input.verified_by — кто подтвердил (id сессии, логин, «human»).
 * @param {{ requireSource?: boolean, now?: () => number }} [options] — политика подтверждения.
 * @returns {{ id: number, status: 'verified' }} результат.
 */
export function verifyMemory(store, input = {}, { requireSource = true, now = () => Date.now() } = {}) {
  if (!store || typeof store.getEntry !== 'function' || typeof store.updateEntry !== 'function'
    || typeof store.listEntrySources !== 'function') {
    throw new TypeError('dsh-memory: memory.verify нужен открытый store (см. lib/store.js)')
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('dsh-memory: memory.verify ждёт объект { id, verified_by }')
  }

  const id = readId(input.id)
  const verifiedBy = readVerifiedBy(input.verified_by)

  const entry = store.getEntry(id)
  if (entry === null) {
    throw new Error(`dsh-memory: запись ${id} не найдена в namespace "${store.namespace}"`)
  }
  if (entry.status === 'stale') {
    throw new Error(`dsh-memory: запись ${id} устарела (stale); сначала перезапишите знание, потом верифицируйте`)
  }
  if (entry.status === 'verified') {
    return { id, status: 'verified' }
  }
  if (requireSource && !hasProvenance(store, entry)) {
    throw new Error(`dsh-memory: запись ${id} без источника — verify запрещён (verify.require_source_for_verified)`)
  }

  const updatedAt = now()
  const updated = store.updateEntry(id, { status: 'verified', updatedAt })
  if (updated === null) {
    throw new Error(`dsh-memory: не удалось обновить запись ${id}`)
  }
  recordVerifyMetricSafely(store, {
    id,
    verifiedBy,
    daysSinceCreated: daysBetween(entry.created_at, updatedAt),
  })
  return { id, status: 'verified' }
}

/** Миллисекунд в сутках — для `days_since_created` в метрике verify. */
const DAY_MS = 24 * 60 * 60 * 1_000

/**
 * Сколько целых дней прошло между созданием записи и подтверждением.
 *
 * @param {unknown} createdAt — `created_at` записи, мс.
 * @param {number} now — время подтверждения, мс.
 * @returns {number} дни (≥ 0).
 */
function daysBetween(createdAt, now) {
  const created = Number(createdAt)
  if (!Number.isFinite(created)) return 0
  return Math.max(0, Math.floor((now - created) / DAY_MS))
}

/**
 * Записать метрику `verify`, не ломая верификацию при ошибке метрик.
 *
 * @param {import('./store.js').MemoryStore} store — хранилище.
 * @param {{ id: number, verifiedBy: string, daysSinceCreated: number }} event — событие.
 * @returns {void}
 */
function recordVerifyMetricSafely(store, event) {
  try {
    recordVerifyMetric(store, event)
  } catch {
    // см. риск «плагин молчит при ошибке» в PLAN.md
  }
}

/**
 * Есть ли у записи провенанс: основной источник или связь в `entry_sources`.
 *
 * @param {import('./store.js').MemoryStore} store — хранилище.
 * @param {Record<string, unknown>} entry — строка записи.
 * @returns {boolean} true, если источник есть.
 */
function hasProvenance(store, entry) {
  const path = typeof entry.source_path === 'string' ? entry.source_path.trim() : ''
  const ref = typeof entry.source_ref === 'string' ? entry.source_ref.trim() : ''
  return path !== '' || ref !== '' || store.listEntrySources(entry.id).length > 0
}

/**
 * Проверить идентификатор записи.
 *
 * @param {unknown} value — значение.
 * @returns {number} id.
 */
function readId(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('dsh-memory: id записи должен быть целым ≥ 1')
  }
  return value
}

/**
 * Проверить, что подтверждение не пустое.
 *
 * @param {unknown} value — значение `verified_by`.
 * @returns {string} подтвердивший.
 */
function readVerifiedBy(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('dsh-memory: verify требует verified_by (кто подтвердил)')
  }
  return value.trim()
}
