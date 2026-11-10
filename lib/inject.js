/**
 * Инъекция top-k в контекст хода (задача 010).
 *
 * На каждом ходе плагин ищет по первым 200 символам последнего сообщения и
 * подмешивает в контекст не более `top_k` (3) записей суммарным бюджетом
 * ≤ 600 токенов. Формат строки: `[memory] title — snippet (source, status)`.
 * Нет попаданий — блока нет и 0 токенов; `DSH_MEMORY_INJECT=off` отключает
 * инъекцию; ошибка поиска не ломает ход (блок просто не добавляется).
 *
 * Модуль синхронный и принимает уже открытый `MemoryStore`: сам он не решает,
 * какой namespace у воркспейса (это делает вызывающий слой — `apply`/хук хода).
 * Добавка к первому токену — `latencyMs` в результате: поиск и сборка строки
 * измеряются вместе, на маленьком индексе это единицы миллисекунд (планка
 * MVP — ≤ 50 мс).
 *
 * @module dsh-memory/inject
 */

import { performance } from 'node:perf_hooks'

import { estimateTokens } from './indexer.js'
import { recordSearchMetric } from './metrics.js'
import { searchMemory, searchMemoryAsync } from './search.js'

/** Сколько символов последнего сообщения идёт в запрос. */
export const INJECT_MESSAGE_CHARS = 200

/** Сколько записей максимум попадает в блок. */
export const INJECT_TOP_K = 3

/** Бюджет блока в «токенах» (оценка, см. `estimateTokens`). */
export const INJECT_TOKEN_BUDGET = 600

/** Префикс каждой строки блока. */
export const INJECT_LINE_PREFIX = '[memory]'

/** Предел сниппета в символах (как `search.snippet_chars`). */
export const INJECT_SNIPPET_CHARS = 300

/**
 * Включена ли инъекция. `DSH_MEMORY_INJECT=off|false|0|no` выключает её;
 * пустое/неизвестное значение оставляет дефолт (включено). `configured=false` —
 * это `inject.enabled: false` из конфига (008).
 *
 * @param {Record<string, string | undefined>} [env] — окружение.
 * @param {boolean} [configured] — включено ли инъекция в конфиге.
 * @returns {boolean} true, если инъекция разрешена.
 */
export function injectionEnabled(env = process.env, configured = true) {
  if (!configured) return false
  const raw = env?.DSH_MEMORY_INJECT
  if (raw === undefined || String(raw).trim() === '') return true
  return !['off', 'false', '0', 'no'].includes(String(raw).trim().toLowerCase())
}

/**
 * Собрать блок памяти для хода.
 *
 * @param {import('./store.js').MemoryStore} store — открытое хранилище namespace.
 * @param {string} message — последнее сообщение пользователя/агента.
 * @param {object} [options] — параметры инъекции.
 * @param {number} [options.topK] — сколько записей максимум (дефолт 3).
 * @param {number} [options.tokenBudget] — бюджет блока в токенах (дефолт 600).
 * @param {number} [options.snippetChars] — предел сниппета (дефолт 300).
 * @param {'verified' | 'all'} [options.status] — какие статусы брать (по умолчанию только verified).
 * @param {Record<string, string | undefined>} [options.env] — окружение для `DSH_MEMORY_INJECT`.
 * @param {boolean} [options.configEnabled] — `inject.enabled` из конфига.
 * @param {boolean} [options.enabled] — явное переопределение (для тестов/хука).
 * @param {'lexical' | 'unicode61'} [options.engine] — движок поиска (задача 020; по умолчанию lexical).
 * @param {boolean} [options.synonyms] — расширять запрос синонимами (по умолчанию да).
 * @param {Array<{ name: string, weight?: number, search: Function }>} [options.channels] — каналы гибридного поиска (016).
 * @returns {{ block: string | null, query: string, hits: number, included: number, tokens: number, latencyMs: number, error: string | null }} результат инъекции.
 */
export function buildMemoryBlock(store, message, options = {}) {
  const {
    topK = INJECT_TOP_K,
    tokenBudget = INJECT_TOKEN_BUDGET,
    snippetChars = INJECT_SNIPPET_CHARS,
    status = 'verified',
    env = process.env,
    configEnabled = true,
    enabled = injectionEnabled(env, configEnabled),
    engine = 'lexical',
    synonyms = true,
    channels = [],
  } = options

  const startedAt = performance.now()
  const query = firstChars(message, INJECT_MESSAGE_CHARS)
  const result = { block: null, query, hits: 0, included: 0, tokens: 0, latencyMs: 0, error: null }

  if (!enabled || query.trim() === '') {
    result.latencyMs = elapsed(startedAt)
    return result
  }

  const limit = readPositiveInt(topK, INJECT_TOP_K)
  const budget = readPositiveInt(tokenBudget, INJECT_TOKEN_BUDGET)

  let found
  try {
    // `any`: в обычном сообщении почти всегда есть слова, которых нет в памяти,
    // строгий AND давал бы пустую выдачу. Метрику пишем сами — нам важен флаг
    // `injected` (попал ли блок в ход) и реальный размер блока.
    found = searchMemory(store, { query, k: limit, status }, {
      snippetChars,
      matchMode: 'any',
      recordMetric: false,
      engine,
      synonyms,
      channels,
    })
  } catch (error) {
    // Ошибка памяти не должна ломать ход: блока просто нет.
    result.error = error instanceof Error ? error.message : String(error)
    result.latencyMs = elapsed(startedAt)
    return result
  }

  return finalizeBlock(store, result, found, { limit, budget, startedAt })
}

/**
 * Асинхронный вариант `buildMemoryBlock` для async-каналов (API/Ollama,
 * задача 016). Контракт результата совпадает.
 *
 * @param {import('./store.js').MemoryStore} store — хранилище.
 * @param {string} message — последнее сообщение.
 * @param {object} [options] — те же опции, что у `buildMemoryBlock`.
 * @returns {Promise<{ block: string | null, query: string, hits: number, included: number, tokens: number, latencyMs: number, error: string | null }>} результат.
 */
export async function buildMemoryBlockAsync(store, message, options = {}) {
  const {
    topK = INJECT_TOP_K,
    tokenBudget = INJECT_TOKEN_BUDGET,
    snippetChars = INJECT_SNIPPET_CHARS,
    status = 'verified',
    env = process.env,
    configEnabled = true,
    enabled = injectionEnabled(env, configEnabled),
    engine = 'lexical',
    synonyms = true,
    channels = [],
  } = options

  const startedAt = performance.now()
  const query = firstChars(message, INJECT_MESSAGE_CHARS)
  const result = { block: null, query, hits: 0, included: 0, tokens: 0, latencyMs: 0, error: null }

  if (!enabled || query.trim() === '') {
    result.latencyMs = elapsed(startedAt)
    return result
  }

  const limit = readPositiveInt(topK, INJECT_TOP_K)
  const budget = readPositiveInt(tokenBudget, INJECT_TOKEN_BUDGET)
  let found
  try {
    found = await searchMemoryAsync(store, { query, k: limit, status }, {
      snippetChars,
      matchMode: 'any',
      recordMetric: false,
      engine,
      synonyms,
      channels,
    })
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    result.latencyMs = elapsed(startedAt)
    return result
  }
  return finalizeBlock(store, result, found, { limit, budget, startedAt })
}

/** Дособрать блок, записать метрику инъекции. */
function finalizeBlock(store, result, found, { limit, budget, startedAt }) {
  result.hits = found.length
  const lines = []
  for (const entry of found) {
    if (lines.length >= limit) break
    const line = formatMemoryLine(entry)
    // Бюджет считаем по готовому блоку (с переводами строк), чтобы
    // estimateTokens(block) гарантированно не превышал tokenBudget. Если
    // строка не влезает — останавливаемся: включать более низкую по рангу
    // запись, пропустив верхнюю, неправильно.
    if (estimateTokens([...lines, line].join('\n')) > budget) break
    lines.push(line)
  }

  if (lines.length > 0) {
    result.block = lines.join('\n')
    result.included = lines.length
    result.tokens = estimateTokens(result.block)
  }
  result.latencyMs = elapsed(startedAt)

  try {
    recordSearchMetric(store, {
      query: result.query,
      hits: result.hits,
      tokensSaved: result.tokens,
      latencyMs: result.latencyMs,
      injected: result.block !== null,
    })
  } catch {
    // см. риск «плагин молчит при ошибке» в PLAN.md
  }
  return result
}

/**
 * Одна строка блока: `[memory] title — snippet (source, status)`.
 *
 * @param {{ title?: string, snippet?: string, source_path?: string | null, source_ref?: string | null, status?: string }} entry — результат поиска.
 * @returns {string} строка блока.
 */
export function formatMemoryLine(entry) {
  const source = entry?.source_path ?? entry?.source_ref ?? 'memory'
  const title = String(entry?.title ?? '').trim()
  const snippet = String(entry?.snippet ?? '').trim()
  const status = entry?.status ?? 'unknown'
  return `${INJECT_LINE_PREFIX} ${title} — ${snippet} (${source}, ${status})`
}

/**
 * Первые `limit` символов строки (по код-поинтам, без разрыва суррогатных пар).
 *
 * @param {unknown} value — исходное значение.
 * @param {number} limit — сколько символов оставить.
 * @returns {string} префикс.
 */
function firstChars(value, limit) {
  return [...String(value ?? '')].slice(0, limit).join('')
}

/**
 * Положительное целое или дефолт.
 *
 * @param {unknown} value — значение.
 * @param {number} fallback — дефолт.
 * @returns {number} целое ≥ 1.
 */
function readPositiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value >= 1 ? value : fallback
}

/**
 * Миллисекунды с начала замера, округлённые до сотых.
 *
 * @param {number} startedAt — `performance.now()` до работы.
 * @returns {number} прошедшие мс.
 */
function elapsed(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100
}
