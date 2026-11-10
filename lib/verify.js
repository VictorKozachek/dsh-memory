/**
 * `memory.verify` (задача 006): подтвердить `draft`-запись и перевести её в
 * `verified`.
 *
 * Правила (спека §5.3, §7; задача 013):
 * - подтверждение обязательно: `verified_by` — PASS ревью/теста
 *   (`reviewer:…`/`verifier:…`/`tester:…`) или человек (`human`);
 *   произвольная строка и голый id сессии не принимаются — это единственный
 *   путь в `verified` (write-back модели всегда `draft`, `confidence ≤ 0.6`);
 * - по умолчанию требуется провенанс (`verify.require_source_for_verified`):
 *   `source_path`/`source_ref` или хотя бы один источник в `entry_sources`; без
 *   источника verify отказывает;
 * - `requireSource: false` — ручное исключение только для `verified_by:
 *   "human"` (человек подтверждает вручную); PASS ревью/теста источник
 *   требует всегда, чтобы не терять 100% verified с провенансом;
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
  if (!hasProvenance(store, entry)) {
    if (requireSource) {
      throw new Error(`dsh-memory: запись ${id} без источника — verify запрещён (verify.require_source_for_verified)`)
    }
    // Ручное исключение: снять требование источника может только человек,
    // подтверждающий вручную. PASS ревью/теста и произвольные подтвердители —
    // нет: метрика проекта требует 100% verified с провенансом.
    if (verifiedBy.toLowerCase() !== 'human') {
      throw new Error(`dsh-memory: запись ${id} без источника — с requireSource:false подтвердить вручную может только "human" (получено "${verifiedBy}")`)
    }
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
 * Кто имеет право подтверждать: PASS ревью/теста или человек.
 * Свободная строка («robot», «x») и голый UUID сессии — не подтверждение:
 * сессия не может сама подтвердить свою запись, сославшись на свой id.
 */
const CONFIRMER = /^(?:human|reviewer|verifier|tester)(?:[-:].+)?$/iu

/**
 * Проверить, что подтверждение не пустое и исходит от положенного лица.
 *
 * Путь в `verified` один (правило 013): PASS ревью/теста
 * (`reviewer:…`/`verifier:…`/`tester:…`) или человек (`human`). Голый id
 * сессии не принимается: роль надо назвать явно, иначе любая сессия (включая
 * модель) могла бы подтвердить сама себя.
 *
 * @param {unknown} value — значение `verified_by`.
 * @returns {string} подтвердивший.
 */
function readVerifiedBy(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('dsh-memory: verify требует verified_by (кто подтвердил)')
  }
  const verifiedBy = value.trim()
  if (!CONFIRMER.test(verifiedBy)) {
    throw new TypeError('dsh-memory: verified_by должен указывать на PASS ревью/теста или человека (human, reviewer:…, verifier:…, tester:…); голый id сессии не принимается')
  }
  return verifiedBy
}
