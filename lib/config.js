/**
 * Конфигурация плагина `dsh-memory`: схема с дефолтами, переменные окружения и
 * правило `namespace: auto`.
 *
 * Источник дефолтов — блок `dsh-memory` из README (и §9 спецификации):
 * namespace, db_path, inject, search, index, embeddings, verify. Значения из
 * ряда Loader-конфига накладываются поверх дефолтов послойно (секция целиком,
 * поле целиком; массивы заменяются), затем — переменные окружения
 * `DSH_MEMORY_DB`, `DSH_MEMORY_INJECT`, `DSH_MEMORY_TOP_K`.
 *
 * Невалидный конфиг не роняет плагин (риск из PLAN.md: «плагин ломает ход при
 * ошибке»): кривое поле заменяется дефолтом, а причина попадает в массив
 * `warnings`. Вызывающий решает, что с ним делать; `apply` пишет их в лог.
 *
 * `namespace: auto` — не «имя сейчас», а правило: оно разрешается в имя
 * каталога воркспейса в момент, когда воркспейс известен. `resolveConfig`
 * разрешает его сразу, если передан `workspace`; иначе конфиг остаётся с
 * `auto`, а `resolveNamespace`/`memory.namespaceFor(cwd)` разрешают позже —
 * у каждой сессии DSH свой рабочий каталог.
 *
 * @module dsh-memory/config
 */

import { basename, resolve } from 'node:path'

/** Значение namespace, означающее «взять имя каталога воркспейса». */
export const AUTO_NAMESPACE = 'auto'

/**
 * Полный конфиг по умолчанию — повторяет блок `dsh-memory` из README.
 * Заморожен: дефолты не должны меняться никем, `resolveConfig` возвращает копию.
 *
 * @type {Readonly<MemoryConfig>}
 */
export const DEFAULT_CONFIG = deepFreeze({
  namespace: AUTO_NAMESPACE,
  db_path: '~/.dsh/memory',
  inject: {
    enabled: true,
    top_k: 3,
    token_budget: 600,
  },
  search: {
    default_status: 'verified',
    snippet_chars: 300,
    synonyms: true,
  },
  index: {
    include: ['**/*.md'],
    exclude: ['.git/**', 'node_modules/**', 'target/**', 'dist/**', 'tmp/**', '.cache/**'],
    max_chunk_tokens: 800,
  },
  embeddings: {
    enabled: false,
    model: '',
  },
  verify: {
    require_source_for_verified: true,
  },
  cascade: {
    enabled: false,
    preset: 'triage',
    model: '',
    max_tokens: 300,
    write_back: true,
  },
})

/** Допустимые значения `search.default_status`. */
const SEARCH_STATUSES = ['verified', 'all']

/** Переменные окружения, перекрывающие конфиг. */
const ENV_KEYS = Object.freeze({
  db: 'DSH_MEMORY_DB',
  inject: 'DSH_MEMORY_INJECT',
  topK: 'DSH_MEMORY_TOP_K',
})

/**
 * Полный конфиг плагина после слияния дефолтов, ряда и окружения.
 *
 * @typedef {object} MemoryConfig
 * @property {string} namespace — namespace памяти; `auto` = имя каталога воркспейса.
 * @property {string} db_path — каталог с файлами БД (`~` раскрывается хранилищем).
 * @property {{ enabled: boolean, top_k: number, token_budget: number }} inject — инъекция top-k в ход.
 * @property {{ default_status: 'verified' | 'all', snippet_chars: number, synonyms: boolean }} search — параметры поиска.
 * @property {{ include: string[], exclude: string[], max_chunk_tokens: number }} index — параметры индексатора.
 * @property {{ enabled: boolean, model: string }} embeddings — эмбеддинги (фаза 4).
 * @property {{ require_source_for_verified: boolean }} verify — правило верификации.
 * @property {{ enabled: boolean, preset: string, model: string, max_tokens: number, write_back: boolean }} cascade — мягкий каскад L1 → L2 (`triage`) → L3 и write-back.
 */

/**
 * Собрать конфиг: дефолты → конфиг ряда → переменные окружения.
 *
 * @param {unknown} raw — `config` Loader-ряда (может быть `undefined`, `null`, не объектом).
 * @param {{ env?: Record<string, string | undefined>, workspace?: string }} [options] — окружение и каталог воркспейса для `namespace: auto`.
 * @returns {{ config: Readonly<MemoryConfig>, warnings: string[] }} готовый конфиг и предупреждения о невалидных значениях.
 */
export function resolveConfig(raw, { env = process.env, workspace } = {}) {
  /** @type {string[]} */
  const warnings = []
  const config = cloneDefaults()

  if (raw !== undefined && raw !== null) {
    if (isPlainObject(raw)) {
      applyUserConfig(config, raw, warnings)
    } else {
      warnings.push(`конфиг: ожидался объект, получено ${describe(raw)} — беру значения по умолчанию`)
    }
  }

  if (workspace !== undefined) {
    try {
      config.namespace = resolveNamespace(config.namespace, workspace)
    } catch (error) {
      warnings.push(`namespace: ${error instanceof Error ? error.message : String(error)} — оставляю "${AUTO_NAMESPACE}"`)
      config.namespace = AUTO_NAMESPACE
    }
  }

  applyEnv(config, env ?? {}, warnings)
  return { config: deepFreeze(config), warnings }
}

/**
 * Разрешить namespace в имя каталога воркспейса, если это `auto`.
 *
 * @param {string} namespace — значение из конфига (`auto` или явное имя).
 * @param {string} [workspace] — каталог воркспейса; без него `auto` остаётся поздним связыванием.
 * @returns {string} имя namespace.
 */
export function resolveNamespace(namespace, workspace) {
  const value = requireString(namespace, 'namespace').trim()
  if (value.toLowerCase() !== AUTO_NAMESPACE) return value
  if (workspace === undefined || workspace === null || String(workspace).trim() === '') return AUTO_NAMESPACE

  const name = basename(resolve(String(workspace)))
  if (name === '' || name === '.' || name === '..') {
    throw new TypeError(`из пути "${workspace}" не получается имя каталога`)
  }
  return name
}

/**
 * Наложить пользовательский конфиг на дефолты: секции и скалярные поля
 * заменяются целиком, неизвестные ключи игнорируются (совместимость вперёд).
 *
 * @param {MemoryConfig} config — изменяемая заготовка с дефолтами.
 * @param {Record<string, unknown>} raw — конфиг ряда.
 * @param {string[]} warnings — накопитель предупреждений.
 * @returns {void}
 */
function applyUserConfig(config, raw, warnings) {
  config.namespace = readString(raw.namespace, 'namespace', config.namespace, warnings)
  config.db_path = readString(raw.db_path, 'db_path', config.db_path, warnings)

  applySection(raw.inject, 'inject', warnings, (section) => {
    config.inject.enabled = readBoolean(section.enabled, 'inject.enabled', config.inject.enabled, warnings)
    config.inject.top_k = readPositiveInt(section.top_k, 'inject.top_k', config.inject.top_k, warnings)
    config.inject.token_budget = readPositiveInt(section.token_budget, 'inject.token_budget', config.inject.token_budget, warnings)
  })

  applySection(raw.search, 'search', warnings, (section) => {
    config.search.default_status = readEnum(section.default_status, 'search.default_status', SEARCH_STATUSES, config.search.default_status, warnings)
    config.search.snippet_chars = readPositiveInt(section.snippet_chars, 'search.snippet_chars', config.search.snippet_chars, warnings)
    config.search.synonyms = readBoolean(section.synonyms, 'search.synonyms', config.search.synonyms, warnings)
  })

  applySection(raw.index, 'index', warnings, (section) => {
    config.index.include = readStringArray(section.include, 'index.include', config.index.include, warnings)
    config.index.exclude = readStringArray(section.exclude, 'index.exclude', config.index.exclude, warnings)
    config.index.max_chunk_tokens = readPositiveInt(section.max_chunk_tokens, 'index.max_chunk_tokens', config.index.max_chunk_tokens, warnings)
  })

  applySection(raw.embeddings, 'embeddings', warnings, (section) => {
    config.embeddings.enabled = readBoolean(section.enabled, 'embeddings.enabled', config.embeddings.enabled, warnings)
    config.embeddings.model = readString(section.model, 'embeddings.model', config.embeddings.model, warnings, { allowEmpty: true })
  })

  applySection(raw.verify, 'verify', warnings, (section) => {
    config.verify.require_source_for_verified = readBoolean(
      section.require_source_for_verified,
      'verify.require_source_for_verified',
      config.verify.require_source_for_verified,
      warnings,
    )
  })

  applySection(raw.cascade, 'cascade', warnings, (section) => {
    config.cascade.enabled = readBoolean(section.enabled, 'cascade.enabled', config.cascade.enabled, warnings)
    config.cascade.preset = readString(section.preset, 'cascade.preset', config.cascade.preset, warnings)
    config.cascade.model = readString(section.model, 'cascade.model', config.cascade.model, warnings, { allowEmpty: true })
    config.cascade.max_tokens = readPositiveInt(section.max_tokens, 'cascade.max_tokens', config.cascade.max_tokens, warnings)
    config.cascade.write_back = readBoolean(section.write_back, 'cascade.write_back', config.cascade.write_back, warnings)
  })
}

/**
 * Применить переменные окружения поверх конфига. Пустое значение считается
 * незаданным; невалидное — предупреждение и прежнее значение.
 *
 * @param {MemoryConfig} config — изменяемый конфиг.
 * @param {Record<string, string | undefined>} env — окружение.
 * @param {string[]} warnings — накопитель предупреждений.
 * @returns {void}
 */
function applyEnv(config, env, warnings) {
  const db = env[ENV_KEYS.db]
  if (db !== undefined && db.trim() !== '') config.db_path = db.trim()

  const inject = env[ENV_KEYS.inject]
  if (inject !== undefined && inject.trim() !== '') {
    const enabled = parseBoolean(inject)
    if (enabled === undefined) {
      warnings.push(`${ENV_KEYS.inject}="${inject}": ожидалось on/off, true/false или 1/0 — оставляю ${config.inject.enabled}`)
    } else {
      config.inject.enabled = enabled
    }
  }

  const topK = env[ENV_KEYS.topK]
  if (topK !== undefined && topK.trim() !== '') {
    if (/^\d+$/.test(topK.trim()) && Number(topK.trim()) >= 1) {
      config.inject.top_k = Number(topK.trim())
    } else {
      warnings.push(`${ENV_KEYS.topK}="${topK}": ожидалось целое ≥ 1 — оставляю ${config.inject.top_k}`)
    }
  }
}

/**
 * Развернуть дефолты в новую изменяемую заготовку: массивы копируются, чтобы
 * замороженные дефолты не были общими для всех вызовов.
 *
 * @returns {MemoryConfig} копия дефолтов.
 */
function cloneDefaults() {
  return {
    namespace: DEFAULT_CONFIG.namespace,
    db_path: DEFAULT_CONFIG.db_path,
    inject: { ...DEFAULT_CONFIG.inject },
    search: { ...DEFAULT_CONFIG.search },
    index: { ...DEFAULT_CONFIG.index, include: [...DEFAULT_CONFIG.index.include], exclude: [...DEFAULT_CONFIG.index.exclude] },
    embeddings: { ...DEFAULT_CONFIG.embeddings },
    verify: { ...DEFAULT_CONFIG.verify },
    cascade: { ...DEFAULT_CONFIG.cascade },
  }
}

/**
 * Применить секцию пользовательского конфига, если она объект.
 *
 * @param {unknown} value — значение секции.
 * @param {string} name — имя секции для предупреждения.
 * @param {string[]} warnings — накопитель предупреждений.
 * @param {(section: Record<string, unknown>) => void} apply — применение полей секции.
 * @returns {void}
 */
function applySection(value, name, warnings, apply) {
  if (value === undefined) return
  if (!isPlainObject(value)) {
    warnings.push(`${name}: ожидался объект, получено ${describe(value)} — беру значения по умолчанию`)
    return
  }
  apply(value)
}

/**
 * Прочитать непустую строку.
 *
 * @param {unknown} value — значение поля.
 * @param {string} field — имя поля.
 * @param {string} fallback — значение по умолчанию.
 * @param {string[]} warnings — накопитель предупреждений.
 * @param {{ allowEmpty?: boolean }} [options] — разрешить пустую строку.
 * @returns {string} значение или fallback.
 */
function readString(value, field, fallback, warnings, { allowEmpty = false } = {}) {
  if (value === undefined) return fallback
  if (typeof value === 'string' && (allowEmpty || value.trim() !== '')) {
    return value.trim()
  }
  warnings.push(`${field}: ожидалась ${allowEmpty ? '' : 'непустая '}строка, получено ${describe(value)} — беру ${JSON.stringify(fallback)}`)
  return fallback
}

/**
 * Прочитать логическое значение.
 *
 * @param {unknown} value — значение поля.
 * @param {string} field — имя поля.
 * @param {boolean} fallback — значение по умолчанию.
 * @param {string[]} warnings — накопитель предупреждений.
 * @returns {boolean} значение или fallback.
 */
function readBoolean(value, field, fallback, warnings) {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  warnings.push(`${field}: ожидалось true/false, получено ${describe(value)} — беру ${fallback}`)
  return fallback
}

/**
 * Прочитать целое число ≥ 1.
 *
 * @param {unknown} value — значение поля.
 * @param {string} field — имя поля.
 * @param {number} fallback — значение по умолчанию.
 * @param {string[]} warnings — накопитель предупреждений.
 * @returns {number} значение или fallback.
 */
function readPositiveInt(value, field, fallback, warnings) {
  if (value === undefined) return fallback
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value
  warnings.push(`${field}: ожидалось целое ≥ 1, получено ${describe(value)} — беру ${fallback}`)
  return fallback
}

/**
 * Прочитать значение из закрытого списка.
 *
 * @param {unknown} value — значение поля.
 * @param {string} field — имя поля.
 * @param {readonly string[]} allowed — допустимые значения.
 * @param {string} fallback — значение по умолчанию.
 * @param {string[]} warnings — накопитель предупреждений.
 * @returns {string} значение или fallback.
 */
function readEnum(value, field, allowed, fallback, warnings) {
  if (value === undefined) return fallback
  if (typeof value === 'string' && allowed.includes(value)) return value
  warnings.push(`${field}: ожидалось ${allowed.join(' | ')}, получено ${describe(value)} — беру ${JSON.stringify(fallback)}`)
  return fallback
}

/**
 * Прочитать массив строк.
 *
 * @param {unknown} value — значение поля.
 * @param {string} field — имя поля.
 * @param {readonly string[]} fallback — массив по умолчанию.
 * @param {string[]} warnings — накопитель предупреждений.
 * @returns {string[]} копия значения или fallback.
 */
function readStringArray(value, field, fallback, warnings) {
  if (value === undefined) return [...fallback]
  if (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    return value.map((item) => item.trim())
  }
  warnings.push(`${field}: ожидался массив непустых строк, получено ${describe(value)} — беру значение по умолчанию`)
  return [...fallback]
}

/**
 * Разобрать булево значение из переменной окружения.
 *
 * @param {string} value — значение переменной.
 * @returns {boolean | undefined} `undefined`, если значение не распознано.
 */
function parseBoolean(value) {
  switch (value.trim().toLowerCase()) {
    case 'on':
    case 'true':
    case '1':
    case 'yes':
      return true
    case 'off':
    case 'false':
    case '0':
    case 'no':
      return false
    default:
      return undefined
  }
}

/**
 * Проверить, что значение — обычный объект (не массив и не `null`).
 *
 * @param {unknown} value — проверяемое значение.
 * @returns {boolean} true для plain-объекта.
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Короткое описание значения для предупреждения.
 *
 * @param {unknown} value — значение.
 * @returns {string} описание вида `строка`, `массив`, `null`, `42`.
 */
function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'массив'
  if (typeof value === 'string') return `строка ${JSON.stringify(value)}`
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return typeof value
}

/**
 * Проверить, что значение — непустая строка, и вернуть её.
 *
 * @param {unknown} value — проверяемое значение.
 * @param {string} field — имя поля для сообщения.
 * @returns {string} исходная строка.
 */
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`поле "${field}" должно быть непустой строкой`)
  }
  return value
}

/**
 * Рекурсивно заморозить объект (и его массивы/вложенные объекты).
 *
 * @template T
 * @param {T} value — значение.
 * @returns {T} то же значение, замороженное.
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}
