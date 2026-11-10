/**
 * Мягкий каскад L1 → L2 → L3 (задача 012).
 *
 * Правило: сначала `memory.search` (L1, 0 токенов модели); при промахе —
 * пресет `triage` (L2, дешёвая модель, контракт `ANSWER | NO_ANSWER`); при
 * `NO_ANSWER` — основная модель (L3). После ответа L2/L3 ответ дистиллируется
 * в память через `memory.write` как `draft` с источником (write-back): в RAG
 * попадает только черновик, `verified` ставится отдельно (006/013).
 *
 * Провайдеры моделей инжектируются (`providers.l2` / `providers.l3`), поэтому
 * модуль не зависит от `dsh-llm` и проверяется мок-провайдерами. Пресет
 * `triage` лежит в `presets/triage.json` и подключается конфигом
 * (`cascade.enabled`, `cascade.preset`, `cascade.model`, `cascade.max_tokens`,
 * `cascade.write_back`).
 *
 * Решения каскада пишутся в `metrics` как `route` (011): L1 — промах/попадание
 * без экономии, L2 — экономия (если провайдер её оценил), L3 — основная модель
 * без экономии. Ошибки памяти и write-back не ломают ход: каскад продолжает
 * отвечать, а запись просто не происходит.
 *
 * Контракт `ANSWER | NO_ANSWER` разбирается и для объектов, и для строк
 * (регистр не важен): `NO_ANSWER`, `NO_ANSWER: причина`, голый `ANSWER` без
 * текста — отказ; `ANSWER: текст` / `ANSWER текст` — ответ с обрезанным
 * префиксом. `cascade.enabled: false` — штатная семантика «без дешёвой модели»:
 * L1 ищется всегда, затем сразу L3. Если провайдер не дал источников, write-back
 * получает синтетический `source_ref` `cascade:L2`/`cascade:L3`.
 *
 * @module dsh-memory/cascade
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRouteReporter } from './route.js'
import { searchMemory } from './search.js'
import { writeMemory } from './write.js'

/** Каталог пресетов пакета. */
export const PRESET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'presets')

/** Файл пресета `triage`. */
export const TRIAGE_PRESET_FILE = join(PRESET_DIR, 'triage.json')

/** Кэш прочитанных пресетов по пути. */
const presetCache = new Map()

/**
 * Прочитать пресет каскада (по умолчанию — `triage`).
 *
 * @param {string} [name] — id пресета; сейчас поддержан только `triage`.
 * @param {string} [file] — путь к JSON (для тестов).
 * @returns {Readonly<{ id: string, name: string, description: string, layer: 'L2', contract: { answer: string, noAnswer: string }, provider: string, model: string, maxTokens: number, temperature: number }>} пресет.
 */
export function loadCascadePreset(name = 'triage', file = TRIAGE_PRESET_FILE) {
  const id = String(name ?? '').trim()
  if (id === '') throw new TypeError('dsh-memory: cascade.preset должен быть непустой строкой')
  if (id !== 'triage') throw new TypeError(`dsh-memory: неизвестный пресет каскада "${id}" (есть только triage)`)
  if (presetCache.has(file)) return presetCache.get(file)

  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (parsed?.id !== 'triage' || parsed?.contract?.answer !== 'ANSWER' || parsed?.contract?.noAnswer !== 'NO_ANSWER') {
    throw new Error(`dsh-memory: пресет ${file} повреждён (нет id/contract ANSWER|NO_ANSWER)`)
  }
  const preset = Object.freeze({
    id: 'triage',
    name: String(parsed.name ?? 'Triage'),
    description: String(parsed.description ?? ''),
    layer: 'L2',
    contract: Object.freeze({ answer: 'ANSWER', noAnswer: 'NO_ANSWER' }),
    provider: String(parsed.provider ?? ''),
    model: String(parsed.model ?? ''),
    maxTokens: Number(parsed.maxTokens ?? 300),
    temperature: Number(parsed.temperature ?? 0),
  })
  presetCache.set(file, preset)
  return preset
}

/**
 * Собрать действующий пресет с перекрытиями из конфига плагина (`cascade`).
 *
 * @param {object} [config] — конфиг плагина (`cascade.enabled|preset|model|max_tokens|write_back`).
 * @returns {{ enabled: boolean, writeBack: boolean, preset: object }} параметры каскада.
 */
export function resolveCascade(config = {}) {
  const section = config?.cascade ?? {}
  const preset = loadCascadePreset(section.preset ?? 'triage')
  const model = typeof section.model === 'string' && section.model.trim() !== '' ? section.model.trim() : preset.model
  const maxTokens = Number.isSafeInteger(section.max_tokens) && section.max_tokens > 0 ? section.max_tokens : preset.maxTokens
  return Object.freeze({
    enabled: section.enabled === true,
    writeBack: section.write_back !== false,
    preset: Object.freeze({ ...preset, model, maxTokens }),
  })
}

/**
 * Провести запрос по каскаду: L1 → L2 (`triage`) → L3, затем write-back.
 *
 * @param {object} options — параметры.
 * @param {import('./store.js').MemoryStore} options.store — открытое хранилище namespace.
 * @param {string} options.query — запрос пользователя.
 * @param {{ l2?: Function, l3?: Function }} [options.providers] — провайдеры моделей.
 * @param {object} [options.config] — конфиг плагина (секция `cascade`).
 * @param {object} [options.tokenMeter] — опциональный `ctx.tokenMeter` для оценки экономии.
 * @param {() => number} [options.now] — часы.
 * @param {Function} [options.search] — подмена `memory.search` (тесты).
 * @param {Function} [options.write] — подмена `memory.write` (тесты).
 * @returns {Promise<{ layer: 'L1' | 'L2' | 'L3', answer: string, source: string | null, entryId: number | null, wroteBack: boolean, status: string | null, error: string | null }>} результат хода.
 */
export async function runCascade({
  store,
  query,
  providers = {},
  config = {},
  tokenMeter,
  now = () => Date.now(),
  search = searchMemory,
  write = writeMemory,
} = {}) {
  if (!store || typeof store.searchEntries !== 'function') {
    throw new TypeError('dsh-memory: runCascade нужен открытый store (см. lib/store.js)')
  }
  if (typeof query !== 'string' || query.trim() === '') {
    throw new TypeError('dsh-memory: runCascade ждёт непустой query')
  }
  const text = query.trim()
  const cascade = resolveCascade(config)
  const reporter = createRouteReporterSafe(store, tokenMeter)
  const report = (decision) => {
    try {
      reporter?.record(decision)
    } catch {
      // Метрика не должна ломать ход.
    }
  }

  // L1: память. Ошибка поиска — промах, а не падение хода.
  let hits = []
  try {
    hits = search(store, { query: text, k: 1, status: 'verified' })
  } catch {
    hits = []
  }
  if (hits.length > 0) {
    const hit = hits[0]
    report({ layer: 'L1', reason: 'memory hit', tokensSavedEstimate: 0, injectedTokens: 0 })
    return {
      layer: 'L1',
      answer: String(hit.snippet ?? ''),
      source: hit.source_path ?? hit.source_ref ?? null,
      entryId: hit.id ?? null,
      wroteBack: false,
      status: 'verified',
      error: null,
    }
  }

  // L2: дешёвая сабмодель по пресету `triage`, если каскад включён и провайдер есть.
  let l2Failure = null
  if (cascade.enabled && typeof providers.l2 === 'function') {
    let reply = null
    try {
      reply = normalizeReply(await providers.l2({ query: text, preset: cascade.preset, contract: cascade.preset.contract }))
    } catch (error) {
      l2Failure = error instanceof Error ? error.message : String(error)
    }
    if (reply !== null && isAnswer(reply)) {
      const saved = Number(reply.tokensSavedEstimate)
      const tokensSavedEstimate = Number.isFinite(saved) && saved > 0 ? saved : 0
      const writeBack = cascade.writeBack
        ? maybeWriteBack({ write, store, layer: 'L2', reply, query: text, now })
        : { wroteBack: false }
      report({ layer: 'L2', reason: 'triage answer', tokensSavedEstimate, injectedTokens: 0 })
      return {
        layer: 'L2',
        answer: reply.answer,
        source: primarySource(reply, 'L2'),
        entryId: writeBack.entryId ?? null,
        wroteBack: writeBack.wroteBack,
        status: writeBack.status ?? null,
        error: writeBack.error ?? null,
      }
    }
  }

  // L3: основная модель.
  if (typeof providers.l3 !== 'function') {
    throw new TypeError('dsh-memory: для L3 нужен providers.l3 (основная модель)')
  }
  const l3Reply = normalizeReply(await providers.l3({ query: text, escalatedFrom: 'L2', reason: l2Failure ?? 'NO_ANSWER' }))
  if (!isAnswer(l3Reply)) {
    throw new Error('dsh-memory: L3 вернул пустой ответ')
  }
  const writeBack = cascade.writeBack
    ? maybeWriteBack({ write, store, layer: 'L3', reply: l3Reply, query: text, now })
    : { wroteBack: false }
  report({
    layer: 'L3',
    reason: l2Failure === null ? 'triage NO_ANSWER' : 'triage error',
    tokensSavedEstimate: 0,
    injectedTokens: 0,
  })
  return {
    layer: 'L3',
    answer: l3Reply.answer,
    source: primarySource(l3Reply, 'L3'),
    entryId: writeBack.entryId ?? null,
    wroteBack: writeBack.wroteBack,
    status: writeBack.status ?? null,
    error: writeBack.error ?? null,
  }
}

/**
 * Создать репортёр route-метрик, не ломая каскад при ошибке.
 *
 * @param {object} store — хранилище.
 * @param {object} [tokenMeter] — token-meter.
 * @returns {object | null} репортёр или null.
 */
function createRouteReporterSafe(store, tokenMeter) {
  try {
    return createRouteReporter(store, { tokenMeter })
  } catch {
    return null
  }
}

/**
 * Привести ответ провайдера к объекту и разобрать контракт `ANSWER | NO_ANSWER`.
 *
 * Провайдер может вернуть строку (тесты и простые адаптеры) или объект. Строка
 * разбирается case-insensitive: `NO_ANSWER` (в том числе `NO_ANSWER: причина`)
 * — это отказ, а не ответ; `ANSWER: текст` / `ANSWER текст` — ответ с
 * обрезанным служебным префиксом; голый `ANSWER` без текста — тоже отказ
 * (пустой ответ бесполезен). Остальная строка считается готовым ответом.
 *
 * @param {unknown} reply — ответ провайдера.
 * @returns {{ status?: string, answer?: string, sources?: unknown, confidence?: number, tokensSavedEstimate?: number, title?: string } | null} нормализованный ответ.
 */
function normalizeReply(reply) {
  if (typeof reply === 'string') return parseAnswerText(reply)
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return null
  if (reply.status === 'NO_ANSWER') return { ...reply, status: 'NO_ANSWER' }
  if (typeof reply.answer === 'string') {
    const parsed = parseAnswerText(reply.answer)
    return parsed.status === 'NO_ANSWER' ? { ...reply, status: 'NO_ANSWER' } : { ...reply, ...parsed }
  }
  return reply
}

/**
 * Разобрать текстовый ответ по контракту `ANSWER | NO_ANSWER`.
 *
 * @param {string} text — ответ провайдера.
 * @returns {{ status: 'ANSWER' | 'NO_ANSWER', answer?: string }} разобранный ответ.
 */
function parseAnswerText(text) {
  const value = String(text ?? '').trim()
  if (value === '') return { status: 'NO_ANSWER' }
  if (/^NO_ANSWER(?=$|[\s:—–-])/iu.test(value)) return { status: 'NO_ANSWER' }
  if (/^ANSWER$/iu.test(value)) return { status: 'NO_ANSWER' }
  const prefixed = /^ANSWER\s*[:—–-]?\s*/iu.exec(value)
  if (prefixed !== null) {
    const answer = value.slice(prefixed[0].length).trim()
    return answer === '' ? { status: 'NO_ANSWER' } : { status: 'ANSWER', answer }
  }
  return { status: 'ANSWER', answer: value }
}

/**
 * Считается ли ответ содержательным (ANSWER, а не NO_ANSWER).
 *
 * @param {object | null} reply — нормализованный ответ.
 * @returns {boolean} true для ANSWER.
 */
function isAnswer(reply) {
  if (reply === null) return false
  if (reply.status === 'NO_ANSWER') return false
  return typeof reply.answer === 'string' && reply.answer.trim() !== ''
}

/**
 * Записать дистиллят ответа L2/L3 в память как `draft` с источником.
 *
 * @param {object} options — параметры.
 * @param {Function} options.write — `memory.write`.
 * @param {object} options.store — хранилище.
 * @param {'L2' | 'L3'} options.layer — слой, давший ответ.
 * @param {object} options.reply — нормализованный ответ.
 * @param {string} options.query — исходный запрос (для title).
 * @param {() => number} options.now — часы.
 * @returns {{ wroteBack: boolean, entryId?: number, status?: string, error?: string }} результат записи.
 */
function maybeWriteBack({ write, store, layer, reply, query, now }) {
  try {
    const written = write(store, {
      kind: 'answer',
      title: String(reply.title ?? titleFromQuery(query)),
      text: reply.answer,
      sources: normalizeSources(reply.sources, layer),
      confidence: layer === 'L2' ? 0.5 : 0.6,
      author: `cascade:${layer}`,
    }, { now })
    return { wroteBack: true, entryId: written.id, status: written.status }
  } catch (error) {
    // Память не должна ломать ответ: ход продолжается без write-back.
    return { wroteBack: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Нормализовать источники ответа; без источников — синтетический ref слоя.
 *
 * @param {unknown} sources — `sources` из ответа провайдера.
 * @param {'L2' | 'L3'} layer — слой.
 * @returns {Array<{ path?: string, ref?: string }>} непустой список источников.
 */
function normalizeSources(sources, layer) {
  const list = Array.isArray(sources) ? sources : []
  const normalized = []
  for (const source of list) {
    if (source === null || typeof source !== 'object') continue
    const path = typeof source.path === 'string' && source.path.trim() !== '' ? source.path.trim() : undefined
    const ref = typeof source.ref === 'string' && source.ref.trim() !== '' ? source.ref.trim() : undefined
    if (path !== undefined || ref !== undefined) normalized.push({ path, ref })
  }
  return normalized.length > 0 ? normalized : [{ ref: `cascade:${layer}` }]
}

/**
 * Основной источник ответа (для результата каскада).
 *
 * @param {object} reply — ответ провайдера.
 * @param {'L2' | 'L3'} layer — слой.
 * @returns {string} путь/ref источника.
 */
function primarySource(reply, layer) {
  const [source] = normalizeSources(reply.sources, layer)
  return source.path ?? source.ref
}

/**
 * Заголовок записи из запроса: первая строка, схлопнутая и обрезанная.
 *
 * @param {string} query — запрос.
 * @returns {string} заголовок.
 */
function titleFromQuery(query) {
  const title = String(query).replace(/\s+/gu, ' ').trim()
  return title.length <= 120 ? title : `${title.slice(0, 119)}…`
}
