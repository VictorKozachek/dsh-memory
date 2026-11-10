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
import { openStore } from './store.js'

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

  /** Открыть/взять хранилище для воркспейса (для опционального пакета эмбеддингов). */
  const storeFor = (workspace) => {
    const namespace = resolveNamespace(options.namespace, workspace)
    let store = stores.get(namespace)
    if (store === undefined) {
      store = openStore({ dbPath: options.db_path, namespace })
      stores.set(namespace, store)
    }
    return store
  }

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
  })

  try {
    ctx?.provide?.(serviceName, memory)
    log(ctx, 'debug', `плагин загружен (namespace: ${options.namespace})`)
  } catch (error) {
    log(ctx, 'warn', `не удалось зарегистрировать сервис "${serviceName}": ${error?.message ?? error}`)
  }

  // Инъекция top-k на каждом ходе: `agent/pre-step` → блок памяти в сообщениях.
  // Ошибка регистрации/открытия БД не должна ронять загрузку профиля.
  try {
    const hook = registerMemoryInjection(ctx, {
      config: options,
      env: process.env,
      channels: searchChannels,
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
      })
    } catch {
      // Контекст без fiber-эффектов (моки в тестах) — очистка не обязательна.
    }
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
