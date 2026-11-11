/**
 * Host-половина плагина `dsh-memory`.
 *
 * Пакет ставится в профиль как обычный bundle: `package.json` объявляет
 * `dsh.bundle.patch`, а `cordis.patch.yml` вставляет Loader-ряд с именем
 * пакета. Cordis импортирует ESM-точку входа и вызывает `apply(ctx, config)` —
 * это единственный контракт, который плагин обязан держать.
 *
 * Конфиг (задача 008) приходит из ряда Loader-конфига и сливается с дефолтами
 * и `DSH_MEMORY_*` в `./config.js`; невалидное значение не роняет загрузку, а
 * попадает предупреждением в лог. Плагин ждёт сервис `agents`: на
 * `agent/pre-step` регистрируется инъекция top-k (010, `./hook.js`), которая
 * добавляет блок памяти в ход. Остальные части (`memory.search`/`write`/…) —
 * модули; единственная оставленная здесь точка входа для них — сервис
 * `ctx.memory`.
 *
 * Ошибка плагина не должна ломать загрузку профиля (риск из PLAN.md: «плагин
 * ломает ход при ошибке»): регистрация обёрнута в try/catch и только пишет
 * предупреждение в лог, если сервис занять не удалось.
 *
 * @module dsh-memory
 */

import { resolveConfig, resolveNamespace } from './config.js'
import { registerMemoryInjection } from './hook.js'
import { createLiveDispatcher } from './live-dispatcher.js'
import { searchMemory, searchMemoryAsync } from './search.js'
import { entryHash, openStore } from './store.js'
import { registerMemoryTools } from './tools.js'
import { verifyMemory } from './verify.js'
import { writeMemory } from './write.js'

/** Имя плагина: cordis использует его в диагностике, оно же видно в логе. */
export const name = 'dsh-memory'

/** Сервисы профиля, без которых плагин не стартует: хук хода живёт на `agents`. */
export const inject = ['agents']

/** Имя сервиса в контексте cordis, через который части плагина видят состояние. */
export const serviceName = 'memory'

/**
 * Параметры плагина после слияния дефолтов, ряда и окружения — см.
 * {@link import('./config.js').MemoryConfig} и `DEFAULT_CONFIG` в `./config.js`.
 *
 * @typedef {import('./config.js').MemoryConfig} Config
 */

/**
 * Зарегистрировать плагин в контексте cordis.
 *
 * Сервис `memory` — точка, за которую дальше цепляются инструменты
 * `memory.*` (задачи 004–007), инъекция top-k (010) и метрики (011). Сейчас
 * сервис хранит конфиг и правило namespace: у каждой сессии свой воркспейс,
 * поэтому `namespace: auto` разрешается через `namespaceFor(cwd)`.
 *
 * @param {object | undefined} ctx — контекст cordis; мок без сервисов тоже допустим.
 * @param {Config | Partial<Config> | null | undefined} [config] — конфиг ряда; невалидный заменяется дефолтами.
 */
export function apply(ctx, config = {}) {
  const { config: options, warnings } = resolveConfig(config)
  for (const warning of warnings) log(ctx, 'warn', warning)

  /** @type {Array<{ name: string, weight?: number, search: Function }>} */
  const searchChannels = []
  /** @type {Map<string, import('./store.js').MemoryStore>} */
  const stores = new Map()
  const liveDispatcher = createLiveDispatcher({
    config: options,
    logger: (level, message) => log(ctx, level, message),
  })

  /** Открыть/взять хранилище по имени namespace (кэш на контекст). */
  const storeForNamespace = (namespace) => {
    let store = stores.get(namespace)
    if (store === undefined) {
      store = openStore({
        dbPath: options.db_path,
        namespace,
        onChange: (change) => {
          try {
            ctx?.emit?.('memory/entries-changed', change)
          } catch {
            // подписчик не должен ломать запись
          }
        },
      })
      stores.set(namespace, store)
    }
    return store
  }

  /** Открыть/взять хранилище для воркспейса (для опционального пакета эмбеддингов). */
  const storeFor = (workspace) => storeForNamespace(resolveNamespace(options.namespace, workspace))

  /** Namespace роли: собственный или общий проектный (029). */
  const roleNamespace = (role, workspace = process.cwd()) => {
    if (role === null || typeof role !== 'object' || typeof role.name !== 'string' || role.name.trim() === '') {
      throw new TypeError('dsh-memory: роль должна иметь непустое name')
    }
    if (options.dispatcher.shared_namespace === true) return resolveNamespace(options.namespace, workspace)
    if (typeof role.namespace !== 'string' || role.namespace.trim() === '') {
      throw new TypeError(`dsh-memory: у роли "${role.name}" должен быть namespace`)
    }
    return role.namespace.trim()
  }

  /** Хранилище роли (свой namespace или общий по конфигу). */
  const storeForRole = (role, workspace) => storeForNamespace(roleNamespace(role, workspace))

  const memory = Object.freeze({
    name,
    config: options,
    /**
     * Разрешить namespace конфига в имя каталога воркспейса (`auto`).
     *
     * @param {string} [workspace] — рабочий каталог сессии/воркспейса.
     * @returns {string} namespace для хранилища.
     */
    namespaceFor: (workspace) => resolveNamespace(options.namespace, workspace),
    /**
     * Хранилище для воркспейса: опциональный пакет эмбеддингов не открывает
     * файл БД сам и не дублирует миграции.
     *
     * @param {string} [workspace] — рабочий каталог.
     * @returns {import('./store.js').MemoryStore} хранилище.
     */
    storeFor,
    /**
     * Namespace роли: собственный `role.namespace` или общий проектный
     * (`dispatcher.shared_namespace: true`, 029).
     *
     * @param {object} role — роль с `name`/`namespace`.
     * @param {string} [workspace] — воркспейс для общего namespace.
     * @returns {string} namespace.
     */
    roleNamespace,
    /**
     * Хранилище роли; каждая роль по умолчанию пишет/читает только свой
     * namespace (029).
     *
     * @param {object} role — роль.
     * @param {string} [workspace] — воркспейс.
     * @returns {import('./store.js').MemoryStore} хранилище.
     */
    storeForRole,
    /**
     * Write-back роли: всегда `draft`, `author: role:<name>`, confidence ≤ 0.6
     * (writeMemory применяет потолок к авторам `role:`); verified — только
     * через `verifyRole`/`memory.verify`.
     *
     * @param {object} role — роль.
     * @param {object} input — запись.
     * @param {{ workspace?: string, now?: () => number }} [writeOptions] — параметры.
     * @returns {{ id: number, deduped: boolean, status: string, namespace: string }} результат.
     */
    writeRole(role, input, { workspace = process.cwd(), now } = {}) {
      const store = storeForRole(role, workspace)
      // Дедупликация не должна превращать write-back в подтверждение чужой
      // verified/human-записи. Роль может дописывать только свой draft ≤ 0.6;
      // всё остальное — явный конфликт, а не тихий возврат status.
      if (input !== null && typeof input === 'object') {
        const existing = findExistingRoleWrite(store, input)
        if (existing !== null) {
          const author = typeof existing.author === 'string' ? existing.author : ''
          const ownedByRole = author === `role:${role.name}`
          if (existing.status !== 'draft' || !ownedByRole || Number(existing.confidence) > 0.6) {
            throw new Error(`dsh-memory: write-back роли "${role.name}" конфликтует с существующей записью ${existing.id} (status=${existing.status}, author=${author || 'none'}, confidence=${existing.confidence}); нужна отдельная запись/ручное решение`)
          }
        }
      }
      const result = writeMemory(store, { ...input, status: 'draft', author: `role:${role.name}` }, now === undefined ? {} : { now })
      return { ...result, status: 'draft', namespace: store.namespace }
    },
    /**
     * Поиск роли строго в её namespace (не видит общую память и чужие роли).
     *
     * @param {object} role — роль.
     * @param {object} input — запрос.
     * @param {{ workspace?: string }} [searchOptions] — параметры.
     * @returns {Array<Record<string, unknown>>} результаты.
     */
    searchRole(role, input, { workspace = process.cwd(), ...searchOptions } = {}) {
      // Роль пишет draft, а дефолтный поиск отдаёт только verified: для
      // собственного namespace роли показываем и черновики (можно переопределить).
      return searchMemory(storeForRole(role, workspace), { status: 'all', ...input }, searchOptions)
    },
    /**
     * Verify в namespace роли с теми же правилами 006: `verified_by` —
     * ревью/тест/человек, провенанс обязателен.
     *
     * @param {object} role — роль.
     * @param {object} input — `{ id, verified_by }`.
     * @param {{ workspace?: string, requireSource?: boolean, now?: () => number }} [verifyOptions] — параметры.
     * @returns {{ id: number, status: string }} результат.
     */
    verifyRole(role, input, { workspace = process.cwd(), ...verifyOptions } = {}) {
      return verifyMemory(storeForRole(role, workspace), input, verifyOptions)
    },
    /**
     * Поиск по памяти для инструмента `memory.search` (016). Асинхронный:
     * каналы эмбеддингов (API/Ollama) должны успеть посчитать embedding запроса.
     * Синхронные каналы тоже работают. Без каналов результат совпадает с FTS5.
     *
     * @param {object} input — запрос `{ query, k?, kinds?, status? }`.
     * @param {{ workspace?: string, snippetChars?: number, engine?: 'lexical'|'unicode61', synonyms?: boolean, now?: () => number }} [options] — параметры.
     * @returns {Promise<Array<Record<string, unknown>>>} результаты.
     */
    search: async (input, { workspace = process.cwd(), ...searchOptions } = {}) => searchMemoryAsync(storeFor(workspace), input, {
      ...searchOptions,
      channels: [...searchChannels],
    }),
    /**
     * Синхронный вариант `memory.search` для CLI/бенчмарка и кода, который не
     * может ждать сетевой канал. Async-каналы здесь пропускаются.
     *
     * @param {object} input — запрос.
     * @param {{ workspace?: string }} [options] — воркспейс.
     * @returns {Array<Record<string, unknown>>} результаты FTS + sync-каналов.
     */
    searchSync: (input, { workspace = process.cwd(), ...searchOptions } = {}) => searchMemory(storeFor(workspace), input, {
      ...searchOptions,
      channels: [...searchChannels],
    }),
    /**
     * Зарегистрировать синхронный канал поиска (016). Основной пакет не знает
     * провайдеров: канал приходит из опционального бандла. Без каналов
     * `memory.search` работает как чистый FTS5.
     *
     * @param {{ name: string, weight?: number, search: Function }} channel — канал.
     * @returns {() => void} снятие канала.
     */
    registerSearchChannel(channel) {
      if (channel === null || typeof channel !== 'object' || typeof channel.name !== 'string' || typeof channel.search !== 'function') {
        throw new TypeError('dsh-memory: канал поиска должен иметь name и search')
      }
      const frozen = Object.freeze({ ...channel })
      searchChannels.push(frozen)
      return () => {
        const index = searchChannels.indexOf(frozen)
        if (index >= 0) searchChannels.splice(index, 1)
      }
    },
    /** Снимок зарегистрированных каналов (для диагностики/тестов). */
    get searchChannels() {
      return [...searchChannels]
    },
    /**
     * Зарегистрировать провайдера роли диспетчера (025). Адаптер DSH-моделей
     * приходит снаружи; без провайдера диспетчер уходит в fallback L3.
     *
     * @param {string} role — имя роли.
     * @param {Function} provider — `({role, subtopic, signal}) => {answer, confidence}`.
     * @returns {() => void} снятие провайдера.
     */
    registerRoleProvider(role, provider) {
      return liveDispatcher.registerProvider(role, provider)
    },
    /**
     * Зарегистрировать planner подтем диспетчера (025/026).
     *
     * @param {Function} planner — `({task, registry}) => subtopics`.
     * @returns {() => void} снятие planner.
     */
    registerDispatcherPlanner(planner) {
      return liveDispatcher.registerPlanner(planner)
    },
    /** Включён ли диспетчер (флаг + валидный реестр ролей). */
    get dispatcherEnabled() {
      return liveDispatcher.enabled
    },
    /** Реестр ролей диспетчера (или null). */
    get dispatcherRoles() {
      return liveDispatcher.registry
    },
  })

  try {
    ctx?.provide?.(serviceName, memory)
    log(ctx, 'debug', `плагин загружен (namespace: ${options.namespace})`)
  } catch (error) {
    log(ctx, 'warn', `не удалось зарегистрировать сервис "${serviceName}": ${error?.message ?? error}`)
  }

  // Инструменты `memory.*` для модели (031): регистрация опциональна, без
  // сервиса `tools` плагин работает как раньше.
  let disposeTools = []
  try {
    let toolsService = null
    try {
      toolsService = ctx?.tools ?? (typeof ctx?.get === 'function' ? ctx.get('tools', false) : null)
    } catch {
      toolsService = null
    }
    if (toolsService !== null && toolsService !== undefined) {
      disposeTools = registerMemoryTools({
        tools: toolsService,
        memory,
        log: (level, message) => log(ctx, level, message),
      })
      if (disposeTools.length === 0) log(ctx, 'debug', 'инструменты memory.* не зарегистрированы')
    } else {
      log(ctx, 'debug', 'сервис tools недоступен: memory.* не регистрируются')
    }
  } catch (error) {
    log(ctx, 'warn', `инструменты memory.* не подключены: ${error?.message ?? error}`)
  }

  // Инъекция top-k на каждом ходе: `agent/pre-step` → блок памяти в сообщениях.
  // Ошибка регистрации/открытия БД не должна ронять загрузку профиля.
  try {
    const hook = registerMemoryInjection(ctx, {
      config: options,
      env: process.env,
      channels: searchChannels,
      dispatcher: liveDispatcher,
      log: (level, message) => log(ctx, level, message),
    })
    if (hook === null) log(ctx, 'debug', 'хук инъекции не зарегистрирован: контекст без agent/pre-step')
  } catch (error) {
    log(ctx, 'warn', `инъекция памяти не подключена: ${error?.message ?? error}`)
  }

  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => () => {
        for (const store of stores.values()) {
          try {
            store.close()
          } catch {
            // Выгрузка плагина не должна падать.
          }
        }
        stores.clear()
        searchChannels.length = 0
        for (const dispose of disposeTools) {
          try {
            dispose()
          } catch {
            // выгрузка не должна падать
          }
        }
        disposeTools = []
      })
    } catch {
      // Контекст без fiber-эффектов (моки в тестах) — очистка не обязательна.
    }
  }
}


/** Найти существующую запись по hash для проверки конфликта writeRole. */
function findExistingRoleWrite(store, input) {
  if (typeof input.kind !== 'string' || typeof input.title !== 'string' || typeof input.text !== 'string') return null
  try {
    return store.findEntryByHash(entryHash(input.kind, input.title, input.text))
  } catch {
    return null
  }
}

/**
 * Записать сообщение в лог cordis, если он есть. Лог — не причина падать:
 * при любой ошибке плагин молчит.
 *
 * @param {object | undefined} ctx — контекст cordis (у мок-контекста логера может не быть).
 * @param {'debug' | 'info' | 'warn'} level — уровень сообщения.
 * @param {string} message — текст без префикса.
 */
function log(ctx, level, message) {
  try {
    const logger = ctx?.logger
    const write = logger?.[level] ?? logger?.info
    if (typeof write === 'function') write.call(logger, `[${name}] ${message}`)
  } catch {
    // Диагностика не может уронить загрузку профиля.
  }
}
