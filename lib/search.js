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

import { performance } from 'node:perf_hooks'

import { estimateSavedTokens, recordSearchMetric } from './metrics.js'
import { synonymsFor } from './synonyms.js'
import { stemVariants, tokenize } from './stemmer.js'
import { isExpired, ttlCutoffs } from './ttl.js'

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
 * `matchMode: "all"` (по умолчанию) требует все слова (неявный AND FTS5),
 * `"any"` соединяет их через `OR` — режим инъекции: в первых 200 символах
 * обычного сообщения почти всегда есть слова, которых нет в памяти, и строгий
 * AND давал бы пустую выдачу.
 *
 * @param {string} query — пользовательский запрос.
 * @param {'all' | 'any'} [matchMode] — как соединять слова.
 * @returns {string} безопасный FTS5-запрос или `''`.
 */
export function toMatchQuery(query, matchMode = 'all') {
  const tokens = String(query ?? '').match(/[\p{L}\p{N}_]+/gu) ?? []
  return tokens.map((token) => `"${token}"`).join(matchMode === 'any' ? ' OR ' : ' ')
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
 * @param {{ defaultStatus?: 'verified' | 'all', defaultK?: number, snippetChars?: number, now?: () => number, matchMode?: 'all' | 'any', recordMetric?: boolean, injected?: boolean, engine?: 'lexical' | 'unicode61', synonyms?: boolean, channels?: Array<{ name: string, weight?: number, search: Function }> }} [options] — дефолты из конфига, часы для TTL, режим MATCH, движок поиска, синонимы, дополнительные каналы поиска (задача 016) и запись метрики.
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

  const matchMode = options.matchMode === 'any' ? 'any' : 'all'
  const engine = options.engine === 'unicode61' ? 'unicode61' : 'lexical'
  const rawMatch = toMatchQuery(query, matchMode)
  const lexMatch = engine === 'lexical' ? buildLexMatch(query, { matchMode, synonyms: options.synonyms !== false }) : ''
  if (engine === 'unicode61' && rawMatch === '') return []
  if (engine === 'lexical' && lexMatch === '') return []

  const k = readPositiveInt(input.k, 'k', options.defaultK ?? DEFAULT_K)
  const status = readStatus(input.status ?? options.defaultStatus ?? DEFAULT_STATUS)
  const kinds = readKinds(input.kinds)
  if (kinds !== undefined && kinds.length === 0) return []

  const namespace = readNamespace(input.namespace)
  if (namespace !== undefined && namespace !== store.namespace) return []

  const snippetChars = readPositiveInt(options.snippetChars, 'snippetChars', DEFAULT_SNIPPET_CHARS, { validateExplicit: false })
  // TTL применяется при выборке: просроченные записи отсекает SQL, поэтому они
  // не занимают место в top-k (см. lib/ttl.js).
  const now = (typeof options.now === 'function' ? options.now : Date.now)()
  const startedAt = performance.now()
  const channels = Array.isArray(options.channels) ? options.channels : []
  const poolLimit = channels.length > 0 ? Math.max(k * 4, 20) : k
  const filters = { limit: poolLimit, kinds, status, expiresBefore: ttlCutoffs(now) }
  let rows
  if (engine === 'unicode61') {
    rows = store.searchEntries(rawMatch, filters)
  } else {
    rows = store.searchLex(lexMatch, filters)
    // Fallback по триграммам: в строгом `all` похожесть требуется для
    // каждого слова запроса, в `any` — хотя бы для одного.
    if (rows.length === 0) rows = searchTrigramFallback(store, query, filters, k, matchMode)
  }

  // Отдельный канал Q&A (задача 020) — часть лексической схемы: verified-ответы
  // по заголовку идут выше обычных сниппетов. У `unicode61` канала нет, иначе
  // сравнение с чистым FTS было бы нечестным. TTL ответов (30 дней) проверяем
  // здесь, в SQL-канале его нет.
  const answers = engine === 'lexical' && status === 'verified' && (kinds === undefined || kinds.includes('answer'))
    ? store.searchVerifiedAnswersByTitle(query, { limit: k })
      .filter((row) => !isExpired(row, now))
      .map((row, index) => ({ ...row, score: -1e9 + Number(row.title_rank ?? 1) * 1_000 + index }))
    : []
  if (channels.length > 0) rows = mergeSearchChannels(store, query, rows, channels, { k: poolLimit, kinds, status, now })
  const merged = []
  const seen = new Set()
  for (const row of [...answers, ...rows]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    merged.push(row)
  }

  const results = merged
    .sort((left, right) => left.score - right.score)
    .slice(0, k)
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

  // Инъекция (010) пишет метрику сама: ей важно знать, добавился ли блок.
  if (options.recordMetric !== false) {
    // Метрика не должна ронять поиск: пишем и молчим при ошибке записи.
    try {
      recordSearchMetric(store, {
        query,
        hits: results.length,
        tokensSaved: estimateSavedTokens(results),
        latencyMs: performance.now() - startedAt,
        injected: Boolean(options.injected),
      })
    } catch {
      // см. риск «плагин молчит при ошибке» в PLAN.md
    }
  }

  return results
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

/**
 * Собрать MATCH-запрос по стеммированному индексу: для каждого слова запроса —
 * группа из Snowball-основы, мягкой основы и синонимов (если включены), группы
 * соединяются AND (`all`) или OR (`any`). Так словоформы и синонимы находятся
 * без векторов.
 *
 * @param {string} query — пользовательский запрос.
 * @param {{ matchMode?: 'all' | 'any', synonyms?: boolean, dictionary?: Map<string, readonly string[]> }} [options] — режим и словарь.
 * @returns {string} FTS5-запрос или `''`.
 */
export function buildLexMatch(query, { matchMode = 'all', synonyms = true, dictionary } = {}) {
  const groups = []
  for (const word of tokenize(query)) {
    const variants = new Set(stemVariants(word))
    if (synonyms) {
      for (const synonym of synonymsFor(word, dictionary)) {
        for (const variant of stemVariants(synonym)) variants.add(variant)
      }
    }
    if (variants.size === 0) continue
    groups.push(`(${[...variants].filter((variant) => variant !== '').map((variant) => `"${variant}"`).join(' OR ')})`)
  }
  return groups.join(matchMode === 'any' ? ' OR ' : ' AND ')
}

/**
 * Собрать MATCH-запрос по trigram-индексу: OR всех триграмм слов запроса.
 * Даёт кандидатов при опечатках; точный ранжир делает {@link trigramSimilarity}.
 *
 * @param {string} query — запрос.
 * @returns {string} FTS5-запрос из триграмм или `''`.
 */
export function buildTrigramMatch(query) {
  const grams = new Set()
  for (const word of tokenize(query)) {
    const chars = [...word]
    for (let index = 0; index + 3 <= chars.length; index += 1) {
      grams.add(chars.slice(index, index + 3).join(''))
    }
  }
  return [...grams].map((gram) => `"${gram}"`).join(' OR ')
}

/**
 * Похожесть запроса на текст по триграммам (Dice): для каждого слова запроса
 * берётся лучшее слово текста. 0 — нет общего, 1 — совпадение.
 *
 * @param {string} query — запрос.
 * @param {string} text — заголовок+текст записи.
 * @returns {number} похожесть 0..1.
 */
export function trigramSimilarity(query, text) {
  const similarities = trigramWordSimilarities(query, text)
  if (similarities.length === 0) return 0
  return similarities.reduce((sum, value) => sum + value, 0) / similarities.length
}

/**
 * Лучшая trigram-похожесть для каждого слова запроса к словам текста.
 *
 * @param {string} query — запрос.
 * @param {string} text — заголовок+текст записи.
 * @returns {number[]} похожести по словам (пусто, если слов короче 3).
 */
function trigramWordSimilarities(query, text) {
  const queryWords = tokenize(query).filter((word) => [...word].length >= 3)
  const textWords = tokenize(text)
  if (queryWords.length === 0 || textWords.length === 0) return []
  const similarities = []
  for (const queryWord of queryWords) {
    const queryGrams = trigramSet(queryWord)
    let best = 0
    for (const textWord of textWords) {
      if (Math.abs([...textWord].length - [...queryWord].length) > 2) continue
      const textGrams = trigramSet(textWord)
      let common = 0
      for (const gram of queryGrams) if (textGrams.has(gram)) common += 1
      const dice = (2 * common) / (queryGrams.size + textGrams.size)
      if (dice > best) best = dice
      if (best === 1) break
    }
    similarities.push(best)
  }
  return similarities
}

/**
 * Слить результаты FTS с результатами дополнительных каналов (задача 016) по
 * reciprocal rank fusion: `sum(weight / (60 + rank))`. Каналы синхронные и
 * возвращают `[{ id, score }]` в порядке убывания; ошибка канала не ломает
 * поиск — канал просто не учитывается. Без каналов `memory.search` работает
 * как раньше (регресс-тест 016).
 *
 * @param {import('./store.js').MemoryStore} store — хранилище.
 * @param {string} query — запрос.
 * @param {Array<Record<string, unknown>>} rows — результаты FTS.
 * @param {Array<{ name: string, weight?: number, search: Function }>} channels — каналы.
 * @param {{ k: number, kinds?: string[], status: 'verified' | 'all', now: number }} options — фильтры.
 * @returns {Array<Record<string, unknown>>} слитые строки с синтетическим `score`.
 */
function mergeSearchChannels(store, query, rows, channels, { k, kinds, status, now }) {
  const ranks = new Map()
  const entries = new Map()
  for (const [index, row] of rows.entries()) {
    ranks.set(row.id, 1 / (60 + index + 1))
    entries.set(row.id, row)
  }
  for (const channel of channels) {
    if (typeof channel?.search !== 'function') continue
    let hits = []
    try {
      hits = channel.search({ store, query, limit: k, kinds, status, now }) ?? []
    } catch {
      continue
    }
    const weight = Number.isFinite(channel.weight) ? channel.weight : 1
    for (const [index, hit] of [...hits].entries()) {
      const id = Number(hit?.id)
      if (!Number.isSafeInteger(id) || id < 1) continue
      let entry = entries.get(id)
      if (entry === undefined) {
        entry = store.getEntry(id)
        if (entry === null || entry.namespace !== store.namespace || entry.status === 'stale') continue
        if (status === 'verified' && entry.status !== 'verified') continue
        if (Array.isArray(kinds) && kinds.length > 0 && !kinds.includes(entry.kind)) continue
        if (isExpired(entry, now)) continue
        entries.set(id, entry)
      }
      ranks.set(id, (ranks.get(id) ?? 0) + weight / (60 + index + 1))
    }
  }
  return [...ranks.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([id, score]) => ({ ...entries.get(id), score: -score }))
}

/**
 * Fallback по trigram-индексу: кандидаты по OR триграмм, затем ранжир по
 * похожести и порог 0.4 (одна опечатка в слове обычно даёт ≥ 0.7).
 *
 * @param {import('./store.js').MemoryStore} store — хранилище.
 * @param {string} query — запрос.
 * @param {object} filters — фильтры FTS.
 * @param {number} k — сколько вернуть.
 * @param {'all' | 'any'} matchMode — требовать похожесть для всех слов или одного.
 * @returns {Array<Record<string, unknown>>} строки с синтетическим `score`.
 */
function searchTrigramFallback(store, query, filters, k, matchMode) {
  const match = buildTrigramMatch(query)
  if (match === '') return []
  const candidates = store.searchTrigram(match, { ...filters, limit: Math.max(k * 8, 40) })
  return candidates
    .map((row) => {
      const similarities = trigramWordSimilarities(query, `${row.title} ${row.text}`)
      const similarity = matchMode === 'all'
        ? (similarities.length > 0 ? Math.min(...similarities) : 0)
        : Math.max(0, ...similarities)
      return { row, similarity }
    })
    .filter((item) => item.similarity >= 0.4)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, k)
    .map((item, index) => ({ ...item.row, score: -1e6 + index }))
}

/**
 * Множество триграмм слова.
 *
 * @param {string} word — слово.
 * @returns {Set<string>} триграммы.
 */
function trigramSet(word) {
  const chars = [...word]
  const grams = new Set()
  for (let index = 0; index + 3 <= chars.length; index += 1) grams.add(chars.slice(index, index + 3).join(''))
  return grams
}
