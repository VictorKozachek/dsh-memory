/**
 * `memory.search` (задача 004): поиск по памяти через FTS5.
 *
 * Контракт (спека §5.3): вход `{ query, k?, kinds?, status?, namespace? }`,
 * выход `[{ id, title, snippet, source_path, source_ref, status, confidence,
 * score }]`, где сниппет ≤ 300 символов, сортировка по `score` (bm25, меньше —
 * лучше), `stale` не возвращается никогда, `draft` виден по `status`.
 *
 * Разделение с хранилищем: SQL-часть (`MATCH`, `bm25`, фильтры `kinds`/
 * `status`, отсечение `stale`) живёт в `MemoryStore.searchEntries`; здесь —
 * контракт инструмента: `k`, `status`, `namespace`, сниппет и форма результата.
 *
 * `status`: `verified` — только проверенные записи (дефолт, как
 * `search.default_status` в README), `all` — проверенные и черновики; `draft`
 * помечается полем `status` в результате. Явный `status: "stale"` — ошибка, а не
 * пустой результат: `stale` не выдаётся принципиально.
 *
 * `namespace`: хранилище уже привязано к namespace (один файл БД на
 * namespace), поэтому параметр — фильтр: если он не совпадает с namespace
 * хранилища, результат пуст. Это не даёт случайно прочитать чужой воркспейс.
 *
 * Невалидный запрос (пустой, не строка, синтаксис FTS5) — пустой массив:
 * инструмент не должен ронять ход. Поломка БД (нет таблицы FTS и т.п.) — не
 * «ничего не найдено», а исключение: её нельзя маскировать.
 *
 * Пользовательский запрос перед `MATCH` санитайзится (`toMatchQuery`):
 * разбивается на слова и каждое оборачивается в кавычки. Иначе пунктуация,
 * которую FTS5 считает синтаксисом, ломает поиск: `dsh-memory` и `Схема:
 * entries` трактуются как column filter и дают `no such column`, а в инъекции
 * top-k (задача 010) запрос — это первые 200 символов обычного хода. Операторы
 * `AND`/`OR`/`NEAR` при этом становятся обычными словами — для MVP это
 * осознанно: естественный текст важнее ручного FTS-синтаксиса.
 *
 * @module dsh-memory/search
 */

/** Допустимые значения фильтра `status`. */
export const SEARCH_STATUSES = Object.freeze(['verified', 'all'])

/** Статус по умолчанию — совпадает с `search.default_status` из README. */
export const DEFAULT_STATUS = 'verified'

/** Сколько записей вернуть, если `k` не задан. */
export const DEFAULT_K = 10

/** Предел сниппета в символах (как `search.snippet_chars` в README). */
export const DEFAULT_SNIPPET_CHARS = 300

/**
 * Санитайзить пользовательский запрос для FTS5 `MATCH`: разбить на слова
 * (`-`, `:`, `/`, `"` и прочая пунктуация — разделители) и каждое слово
 * обернуть в кавычки. Пустая строка в результате означает «нет слов».
 *
 * @param {string} query — пользовательский запрос.
 * @returns {string} безопасный FTS5-запрос или `''`.
 */
export function toMatchQuery(query) {
  const tokens = String(query ?? '').match(/[\p{L}\p{N}_]+/gu) ?? []
  return tokens.map((token) => `"${token}"`).join(' ')
}

/**
 * Найти записи в памяти.
 *
 * @param {import('./store.js').MemoryStore} store — открытое хранилище namespace.
 * @param {object} [input] — параметры поиска.
 * @param {string} [input.query] — запрос FTS5; пустой/невалидный даёт пустой массив.
 * @param {number} [input.k] — сколько записей вернуть (целое ≥ 1).
 * @param {readonly string[]} [input.kinds] — фильтр по `kind` записи.
 * @param {'verified' | 'all'} [input.status] — какие статусы возвращать.
 * @param {string} [input.namespace] — ожидаемый namespace; при расхождении с хранилищем результат пуст.
 * @param {{ defaultStatus?: 'verified' | 'all', defaultK?: number, snippetChars?: number }} [options] — дефолты из конфига.
 * @returns {Array<{ id: number, title: string, snippet: string, source_path: string | null, source_ref: string | null, status: string, confidence: number, score: number }>} результаты поиска.
 */
export function searchMemory(store, input = {}, options = {}) {
  if (!store || typeof store.searchEntries !== 'function' || typeof store.namespace !== 'string') {
    throw new TypeError('dsh-memory: memory.search нужен открытый store (см. lib/store.js)')
  }
  if (input === undefined || input === null) input = {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('dsh-memory: memory.search ждёт объект { query, k?, kinds?, status?, namespace? }')
  }

  const query = input.query
  if (typeof query !== 'string' || query.trim() === '') return []

  const match = toMatchQuery(query)
  if (match === '') return []

  const k = readPositiveInt(input.k, 'k', options.defaultK ?? DEFAULT_K)
  const status = readStatus(input.status ?? options.defaultStatus ?? DEFAULT_STATUS)
  const kinds = readKinds(input.kinds)
  if (kinds !== undefined && kinds.length === 0) return []

  const namespace = readNamespace(input.namespace)
  if (namespace !== undefined && namespace !== store.namespace) return []

  const snippetChars = readPositiveInt(options.snippetChars, 'snippetChars', DEFAULT_SNIPPET_CHARS, { validateExplicit: false })
  const rows = store.searchEntries(match, { limit: k, kinds, status })

  return rows
    // Хранилище уже отсекает stale; повторная проверка — дешёвая страховка.
    .filter((row) => row.status !== 'stale')
    .map((row) => ({
      id: row.id,
      title: row.title,
      snippet: buildSnippet(row.text, query, snippetChars),
      source_path: row.source_path ?? null,
      source_ref: row.source_ref ?? null,
      status: row.status,
      confidence: row.confidence,
      score: row.score,
    }))
    .sort((left, right) => left.score - right.score)
}

/**
 * Прочитать `k`: явно заданное значение обязано быть целым ≥ 1, отсутствующее
 * заменяется дефолтом.
 *
 * @param {unknown} value — значение из входа или конфига.
 * @param {string} field — имя поля для ошибки.
 * @param {number} fallback — дефолт.
 * @param {{ validateExplicit?: boolean }} [options] — проверять ли явное значение.
 * @returns {number} размер выборки.
 */
function readPositiveInt(value, field, fallback, { validateExplicit = true } = {}) {
  if (value === undefined || value === null) return fallback
  if (Number.isSafeInteger(value) && value >= 1) return value
  if (!validateExplicit) return fallback
  throw new TypeError(`dsh-memory: ${field} должен быть целым ≥ 1`)
}

/**
 * Прочитать фильтр `status`.
 *
 * @param {unknown} value — значение.
 * @returns {'verified' | 'all'} статус.
 */
function readStatus(value) {
  if (!SEARCH_STATUSES.includes(value)) {
    throw new TypeError(`dsh-memory: status должен быть ${SEARCH_STATUSES.join(' | ')}; получено ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Прочитать фильтр `kinds`.
 *
 * @param {unknown} value — значение.
 * @returns {string[] | undefined} список типов или undefined (без фильтра).
 */
function readKinds(value) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new TypeError('dsh-memory: kinds должен быть массивом строк')
  return value.map((kind, index) => {
    if (typeof kind !== 'string' || kind.trim() === '') {
      throw new TypeError(`dsh-memory: kinds[${index}] должен быть непустой строкой`)
    }
    return kind.trim()
  })
}

/**
 * Прочитать и проверить namespace.
 *
 * @param {unknown} value — значение.
 * @returns {string | undefined} namespace или undefined.
 */
function readNamespace(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('dsh-memory: namespace должен быть непустой строкой')
  }
  return value.trim()
}

/**
 * Собрать сниппет не длиннее `maxChars` символов: окно вокруг первого
 * вхождения слова запроса, обрезка по границе слова и многоточия по краям.
 * Полный текст записи наружу не отдаётся.
 *
 * @param {unknown} text — текст записи.
 * @param {string} query — запрос.
 * @param {number} maxChars — предел сниппета.
 * @returns {string} сниппет.
 */
function buildSnippet(text, query, maxChars) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean === '') return ''
  if (clean.length <= maxChars) return clean

  const tokens = [...new Set((query.match(/[\p{L}\p{N}_]+/gu) ?? [])
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2))]
  const lower = clean.toLowerCase()
  let hit = -1
  for (const token of tokens) {
    const index = lower.indexOf(token)
    if (index !== -1 && (hit === -1 || index < hit)) hit = index
  }

  let start = hit > 60 ? hit - 60 : 0
  const prefix = start > 0 ? '…' : ''
  let end = Math.min(clean.length, start + Math.max(1, maxChars - prefix.length - 1))
  if (end < clean.length) {
    const space = clean.lastIndexOf(' ', end)
    if (space > start + Math.floor(maxChars / 4)) end = space
  }
  const suffix = end < clean.length ? '…' : ''
  const result = `${prefix}${clean.slice(start, end).trim()}${suffix}`

  const chars = [...result]
  return chars.length <= maxChars ? result : `${chars.slice(0, maxChars - 1).join('')}…`
}
