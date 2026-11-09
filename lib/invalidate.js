/**
 * `memory.invalidate` (задача 006): пометить связанные записи `stale`.
 *
 * Инвалидация — по источнику: `path` (файл воркспейса) или `ref`
 * (коммит/задача/URL). Запись считается связанной, если совпал основной
 * провенанс (`entries.source_path`/`source_ref`) или любой источник из
 * `entry_sources` (их объединяет `memory.write`). Возврат — сколько записей
 * стали `stale` этим вызовом; уже `stale` повторно не считаются.
 *
 * `stale` не возвращается `memory.search` ни при каком фильтре статуса
 * (критерий 006), поэтому инвалидация сразу убирает запись из выдачи.
 *
 * @module dsh-memory/invalidate
 */

/**
 * Пометить записи, связанные с `path` и/или `ref`, как `stale`.
 *
 * @param {import('./store.js').MemoryStore} store — открытое хранилище namespace.
 * @param {object} input — что инвалидировать.
 * @param {string} [input.path] — путь файла от корня воркспейса.
 * @param {string} [input.ref] — коммит/задача/URL.
 * @param {{ now?: () => number }} [options] — часы для `updated_at`.
 * @returns {{ affected: number }} сколько записей стало stale.
 */
export function invalidateMemory(store, input = {}, { now = () => Date.now() } = {}) {
  if (!store || typeof store.invalidateBySource !== 'function') {
    throw new TypeError('dsh-memory: memory.invalidate нужен открытый store (см. lib/store.js)')
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('dsh-memory: memory.invalidate ждёт объект { path?, ref? }')
  }

  const path = optionalString(input.path, 'path')
  const ref = optionalString(input.ref, 'ref')
  if (path === undefined && ref === undefined) {
    throw new TypeError('dsh-memory: memory.invalidate нужен path или ref')
  }

  const affected = store.invalidateBySource({ path: path ?? null, ref: ref ?? null }, now())
  return { affected }
}

/**
 * Прочитать необязательный непустой идентификатор источника.
 *
 * @param {unknown} value — значение из входа.
 * @param {string} field — имя поля для ошибки.
 * @returns {string | undefined} строка или undefined.
 */
function optionalString(value, field) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`dsh-memory: поле "${field}" должно быть непустой строкой`)
  }
  return value.trim()
}
