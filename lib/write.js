/**
 * `memory.write` (задача 005): запись знания в память с дедупликацией и
 * провенансом.
 *
 * Контракт (спека §5.3): вход `{ text, title, kind, sources: [{ path?, ref? }],
 * confidence?, status?: "draft" }`, выход `{ id, deduped, status }`.
 *
 * Правила:
 * - запись всегда `draft`: `verified` ставится только `memory.verify` (006),
 *   поэтому `status: "verified"` здесь — ошибка, а не молчаливое понижение;
 * - `hash = sha256(kind|title|text)` (считает хранилище): повторная запись с тем
 *   же содержимым не создаёт дубль, а повышает `confidence` и объединяет
 *   провенанс (`deduped: true`);
 * - без источника запись допустима только как `draft` с `confidence < 0.5`
 *   (дефолт 0.3); с источником дефолт 0.5. Верхняя граница draft `≤ 0.6` —
 *   правило задачи 013, здесь она не навязывается;
 * - провенанс: `entries.source_path`/`source_ref` — основной источник (первый
 *   из списка), полный список живёт в `entry_sources` (миграция 2 хранилища) и
 *   пополняется при каждом дубле;
 * - дедупликация идёт в рамках namespace хранилища: `memory.write` работает с
 *   уже открытым `MemoryStore` (namespace выбирает конфиг/воркспейс).
 *
 * @module dsh-memory/write
 */

import { entryHash } from './store.js'

/** Допустимые `kind` записи (спека §5.1). */
export const ENTRY_KINDS = Object.freeze(['doc', 'decision', 'fact', 'answer', 'code-note'])

/** Единственный статус, который пишет `memory.write`. */
export const WRITE_STATUS = 'draft'

/** Дефолтная уверенность записи без источника — ниже порога 0.5. */
const CONFIDENCE_WITHOUT_SOURCE = 0.3

/** Дефолтная уверенность записи с источником. */
const CONFIDENCE_WITH_SOURCE = 0.5

/** Насколько подтверждение (дубль) поднимает уверенность. */
const CONFIRMATION_BOOST = 0.1

/**
 * Записать знание в память.
 *
 * @param {import('./store.js').MemoryStore} store — открытое хранилище namespace.
 * @param {object} input — что записать.
 * @param {string} input.text — полный текст знания.
 * @param {string} input.title — заголовок.
 * @param {string} input.kind — `doc` | `decision` | `fact` | `answer` | `code-note`.
 * @param {Array<{ path?: string, ref?: string }>} [input.sources] — провенанс: файл и/или коммит/задача/URL.
 * @param {number} [input.confidence] — уверенность 0..1; без источника обязана быть < 0.5.
 * @param {string} [input.status] — разрешён только `draft` (или отсутствие).
 * @param {string} [input.author] — автор записи (id сессии/логин).
 * @param {{ now?: () => number }} [options] — часы для `created_at`/`updated_at`.
 * @returns {{ id: number, deduped: boolean, status: string }} результат записи.
 */
export function writeMemory(store, input, { now = () => Date.now() } = {}) {
  if (!store || typeof store.findEntryByHash !== 'function' || typeof store.insertEntry !== 'function') {
    throw new TypeError('dsh-memory: memory.write нужен открытый store (см. lib/store.js)')
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('dsh-memory: memory.write ждёт объект { text, title, kind, sources? }')
  }

  const kind = readKind(input.kind)
  const title = readRequiredString(input.title, 'title')
  const text = readRequiredString(input.text, 'text')
  const status = input.status ?? WRITE_STATUS
  if (status !== WRITE_STATUS) {
    throw new TypeError(`dsh-memory: memory.write пишет только "${WRITE_STATUS}"; "${status}" ставится другими инструментами`)
  }

  const sources = normalizeSources(input.sources)
  const confidence = resolveConfidence(input.confidence, sources)
  const hash = entryHash(kind, title, text)
  const timestamp = now()
  // В колонках entries — один основной файл и один основной ref: берём первые
  // заданные независимо, полный список остаётся в entry_sources.
  const primaryPath = sources.find((source) => source.path !== undefined)?.path ?? null
  const primaryRef = sources.find((source) => source.ref !== undefined)?.ref ?? null

  const existing = store.findEntryByHash(hash)
  if (existing === null) {
    const { id } = store.insertEntry({
      kind,
      title,
      text,
      status: WRITE_STATUS,
      confidence,
      sourcePath: primaryPath,
      sourceRef: primaryRef,
      author: input.author ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    store.addEntrySources(id, sources)
    return { id, deduped: false, status: WRITE_STATUS }
  }

  // Дубль: подтверждение повышает уверенность, провенанс объединяется.
  const boosted = roundConfidence(Math.min(1, Math.max(Number(existing.confidence) || 0, confidence) + CONFIRMATION_BOOST))
  const patch = { confidence: boosted, updatedAt: timestamp }
  if (!existing.source_path && primaryPath) patch.sourcePath = primaryPath
  if (!existing.source_ref && primaryRef) patch.sourceRef = primaryRef
  store.updateEntry(existing.id, patch)
  store.addEntrySources(existing.id, sources)

  return { id: existing.id, deduped: true, status: existing.status ?? WRITE_STATUS }
}

/**
 * Проверить и вернуть `kind` записи.
 *
 * @param {unknown} value — значение `kind`.
 * @returns {string} допустимый kind.
 */
function readKind(value) {
  const kind = readRequiredString(value, 'kind')
  if (!ENTRY_KINDS.includes(kind)) {
    throw new TypeError(`dsh-memory: kind должен быть одним из ${ENTRY_KINDS.join(', ')}; получено "${kind}"`)
  }
  return kind
}

/**
 * Проверить, что значение — непустая строка.
 *
 * @param {unknown} value — значение.
 * @param {string} field — имя поля для ошибки.
 * @returns {string} исходная строка.
 */
function readRequiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`dsh-memory: поле "${field}" должно быть непустой строкой`)
  }
  return value
}

/**
 * Нормализовать провенанс: массив `{ path?, ref? }`, в каждом элементе есть
 * хотя бы одно поле. Пустые строки приводятся к `undefined`.
 *
 * @param {unknown} value — `sources` из входа.
 * @returns {Array<{ path?: string, ref?: string }>} нормализованный список.
 */
function normalizeSources(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new TypeError('dsh-memory: sources должен быть массивом { path?, ref? }')

  return value.map((source, index) => {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) {
      throw new TypeError(`dsh-memory: sources[${index}] должен быть объектом { path?, ref? }`)
    }
    const path = optionalString(source.path, `sources[${index}].path`)
    const ref = optionalString(source.ref, `sources[${index}].ref`)
    if (path === undefined && ref === undefined) {
      throw new TypeError(`dsh-memory: sources[${index}] должен содержать path или ref`)
    }
    return Object.freeze({ path, ref })
  })
}

/**
 * Прочитать необязательную непустую строку.
 *
 * @param {unknown} value — значение.
 * @param {string} field — имя поля для ошибки.
 * @returns {string | undefined} строка или undefined.
 */
function optionalString(value, field) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`dsh-memory: поле "${field}" должно быть непустой строкой`)
  }
  return value
}

/**
 * Определить уверенность записи и проверить правило «без источника — < 0.5».
 *
 * @param {unknown} value — `confidence` из входа (если задана).
 * @param {ReadonlyArray<unknown>} sources — нормализованный провенанс.
 * @returns {number} уверенность 0..1.
 */
function resolveConfidence(value, sources) {
  const hasSource = sources.length > 0
  const fallback = hasSource ? CONFIDENCE_WITH_SOURCE : CONFIDENCE_WITHOUT_SOURCE
  const confidence = value === undefined ? fallback : value

  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new TypeError('dsh-memory: confidence должна быть числом 0..1')
  }
  if (!hasSource && confidence >= 0.5) {
    throw new RangeError('dsh-memory: запись без источника допустима только с confidence < 0.5')
  }
  return roundConfidence(confidence)
}

/**
 * Округлить уверенность до сотых, чтобы 0.5 + 0.1 не превращалось в
 * 0.6000000000000001 в отчётах и тестах.
 *
 * @param {number} value — уверенность.
 * @returns {number} округлённая уверенность.
 */
function roundConfidence(value) {
  return Math.round(value * 100) / 100
}
