/**
 * Per-turn хук инъекции памяти (задача 010).
 *
 * DSH даёт плагинам waterfall `agent/pre-step` (см. `packages/context/
 * time-context`): слушатель получает `{ agent, messages, turn, step, signal }`,
 * вызывает `next()` и может вернуть решение с дополнительными сообщениями.
 * Хук:
 * 1. берёт последнее **пользовательское** сообщение хода (claimed-сообщения
 *    шага, иначе — последнее `user/message` в логе сессии; свои plugin-вставки
 *    пропускаются), первые 200 символов уходят в `buildMemoryBlock`;
 * 2. открывает/переиспользует хранилище по `cwd` сессии (`session.header.cwd`)
 *    и namespace конфига (`namespace: auto` → имя каталога воркспейса);
 * 3. добавляет блок как `user`-сообщение с `source: { kind: 'plugin', plugin:
 *    'dsh-memory', form: 'snapshot', sections: [...] }` — как это делает
 *    time-context, но без импорта `@deepseek-ai/dsh-llm`: сообщение строится
 *    по тем же полям и замораживается;
 * 4. любые ошибки (нет БД, битый индекс, отключённая инъекция) глотает — ход
 *    продолжается без памяти;
 * 5. инъекция выполняется на первом шаге хода или когда в шаг пришло новое
 *    пользовательское сообщение (steering), чтобы не вставлять один и тот же
 *    блок на каждый tool-шаг.
 *
 * Хранилища кэшируются по namespace и закрываются вместе с контекстом плагина
 * (`ctx.effect`). Успешная инъекция пишет и `route`-событие слоя L1 (задача
 * 011): оценку экономии считает `dsh-token-meter`, если сервис доступен, иначе
 * локальная эвристика (см. `lib/route.js`).
 *
 * @module dsh-memory/hook
 */

import { randomUUID } from 'node:crypto'

import { createAutoindexScheduler } from './autoindex.js'
import { resolveNamespace } from './config.js'
import { buildMemoryBlockAsync, injectionEnabled } from './inject.js'
import { recordDispatchMetric } from './metrics.js'
import { createRouteReporter } from './route.js'
import { openStore } from './store.js'
import { optionalTokenMeter } from './token-meter.js'

/** Имя плагина в `source.plugin` внедрённого сообщения. */
export const PLUGIN_NAME = 'dsh-memory'

/** Имя события DSH, в которое встраивается память. */
export const PRE_STEP_EVENT = 'agent/pre-step'

/**
 * Зарегистрировать хук `agent/pre-step` в контексте плагина.
 *
 * @param {object} ctx — контекст cordis (нужен `on`; `effect` — для очистки).
 * @param {object} [options] — параметры хука.
 * @param {object} [options.config] — разрешённый конфиг плагина (см. `lib/config.js`).
 * @param {Record<string, string | undefined>} [options.env] — окружение (`DSH_MEMORY_INJECT`).
 * @param {{ enabled: boolean, dispatch: Function }} [options.dispatcher] — живой диспетчер ролей (025); disabled — не вызывается.
 * @param {(level: 'debug' | 'info' | 'warn', message: string) => void} [options.log] — лог.
 * @returns {{ handler: Function, close: () => void } | null} зарегистрированный хук или null, если контекст не умеет `on`.
 */
export function registerMemoryInjection(ctx, { config = {}, env = process.env, log = () => {}, channels = [], dispatcher = null, autoindexer = null, indexer } = {}) {
  if (typeof ctx?.on !== 'function') return null

  const dbPath = config.db_path ?? '~/.dsh/memory'
  const namespace = config.namespace ?? 'auto'
  const topK = config.inject?.top_k ?? 3
  const tokenBudget = config.inject?.token_budget ?? 600
  const snippetChars = config.search?.snippet_chars ?? 300
  const configEnabled = config.inject?.enabled ?? true

  /** @type {Map<string, import('./store.js').MemoryStore>} */
  const stores = new Map()
  /** @type {Map<string, ReturnType<typeof createRouteReporter>>} */
  const reporters = new Map()
  const tokenMeter = optionalTokenMeter(ctx)
  const autoindex = autoindexer ?? createAutoindexScheduler({
    ...(indexer === undefined ? {} : { indexer }),
    logger: log,
  })

  /** Открыть/взять хранилище для воркспейса сессии. */
  const storeFor = (workspace) => {
    const name = resolveNamespace(namespace, workspace)
    let store = stores.get(name)
    if (store === undefined) {
      store = openStore({
        dbPath,
        namespace: name,
        onChange: (change) => {
          try {
            ctx?.emit?.('memory/entries-changed', change)
          } catch {
            // подписчик не должен ломать запись
          }
        },
      })
      stores.set(name, store)
      reporters.set(name, createRouteReporter(store, { tokenMeter }))
      log('debug', `хранилище памяти открыто: namespace "${name}"`)
    }
    return store
  }

  /** Репортёр route-событий для воркспейса (см. `lib/route.js`). */
  const reporterFor = (workspace) => {
    const name = resolveNamespace(namespace, workspace)
    storeFor(workspace)
    return reporters.get(name)
  }

  /** Записать dispatch-метрику (028); ошибка метрики не ломает ход. */
  const recordDispatch = (workspace, dispatched) => {
    try {
      recordDispatchMetric(storeFor(workspace), {
        subtopics: dispatched?.subtopics ?? 0,
        roles: dispatched?.roles ?? [],
        durationsMs: dispatched?.durationsMs ?? {},
        strategy: dispatched?.strategy ?? 'priority',
        fallback: dispatched?.fallback === true,
        reason: dispatched?.reason ?? '',
        latencyMs: dispatched?.latencyMs ?? 0,
      })
    } catch {
      // метрика вспомогательная
    }
  }

  const close = () => {
    for (const store of stores.values()) {
      try {
        store.close()
      } catch {
        // Закрытие не должно мешать выгрузке плагина.
      }
    }
    stores.clear()
    reporters.clear()
  }

  const handler = async (payload, next) => {
    const decision = await next()
    if (decision?.kind === 'reject') return decision
    if (payload?.signal?.aborted) return decision
    if (!injectionEnabled(env, configEnabled)) return decision

    try {
      const claimed = humanMessages(payload?.messages)
      // Не первый шаг и нет нового пользовательского сообщения — этот ход уже
      // получил память на первом шаге.
      if (payload?.step !== 1 && claimed.length === 0) return decision
      const message = claimed.length > 0
        ? messageText(claimed[claimed.length - 1])
        : lastUserMessageFromSession(payload?.agent)
      if (message.trim() === '') return decision

      const workspace = payload?.agent?.session?.header?.cwd ?? process.cwd()
      // Первый ход в пустом воркспейсе: индексация в фоне, не блокируя ход.
      try {
        autoindex.maybeSchedule({ store: storeFor(workspace), workspace, config, env })
      } catch (error) {
        log('warn', `автоиндексация не запланирована: ${error instanceof Error ? error.message : String(error)}`)
      }
      const result = await buildMemoryBlockAsync(storeFor(workspace), message, {
        topK,
        tokenBudget,
        snippetChars,
        env,
        configEnabled,
        synonyms: config.search?.synonyms ?? true,
        channels,
      })

      // L1 промах: если включён диспетчер, пробуем роли; иначе ход идёт на L3
      // (обычный AgentLoop). Отмена не должна уходить в L3.
      if (result.block === null && dispatcher?.enabled === true) {
        let dispatched
        try {
          dispatched = await dispatcher.dispatch({ task: message, signal: payload?.signal })
        } catch (error) {
          if (payload?.signal?.aborted || error?.name === 'AbortError') return decision
          log('warn', `dispatcher пропущен: ${error instanceof Error ? error.message : String(error)}`)
          return decision
        }
        if (payload?.signal?.aborted) return decision
        recordDispatch(workspace, dispatched)
        if (dispatched?.fallback === false && typeof dispatched.answer === 'string' && dispatched.answer.trim() !== '') {
          try {
            reporterFor(workspace)?.record({ layer: 'L2', reason: 'dispatcher', text: dispatched.answer })
          } catch {
            // метрика не должна ломать ход
          }
          return {
            ...decision,
            messages: [...decision.messages, createPluginMessage(dispatched.answer, `${PLUGIN_NAME}-dispatcher`)],
          }
        }
        log('debug', `dispatcher fallback: ${dispatched?.reason ?? 'нет ответа'}`)
        return decision
      }
      if (result.block === null) return decision

      // Метрика L1: оценку экономии считает token-meter, если он есть; иначе —
      // локальная эвристика. Ошибка метрики не мешает инъекции.
      try {
        reporterFor(workspace)?.record({ layer: 'L1', reason: 'memory injection', text: result.block })
      } catch {
        // см. риск «плагин молчит при ошибке» в PLAN.md
      }

      return {
        ...decision,
        messages: [...decision.messages, createPluginMessage(result.block)],
      }
    } catch (error) {
      log('warn', `инъекция памяти пропущена: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  }

  try {
    ctx.on(PRE_STEP_EVENT, handler, { prepend: true })
  } catch (error) {
    log('warn', `хук инъекции не зарегистрирован: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }

  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => close)
    } catch {
      // Контекст без fiber-эффектов (моки в тестах) — закрытие не обязательно.
    }
  }

  log('debug', 'хук инъекции памяти зарегистрирован (agent/pre-step)')
  return { handler, close }
}

/**
 * Сообщение с блоком памяти — та же форма, что у `createUserMessage` из
 * `@deepseek-ai/dsh-llm` (role user, plugin-source, snapshot-секции), но без
 * импорта пакета, чтобы плагин оставался без зависимостей.
 *
 * @param {string} text — блок памяти.
 * @param {string} [plugin] — имя плагина.
 * @returns {Readonly<{ id: string, role: 'user', content: ReadonlyArray<{ type: 'text', text: string }>, source: Readonly<object> }>} сообщение.
 */
export function createPluginMessage(text, plugin = PLUGIN_NAME) {
  const sections = Object.freeze([Object.freeze({ name: plugin, text })])
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'plugin', plugin, form: 'snapshot', sections }),
  })
}

/**
 * Текстовое содержимое сообщения (склейка text-блоков).
 *
 * @param {unknown} message — сообщение с `content`.
 * @returns {string} текст.
 */
export function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Пользовательские (не plugin/tool) сообщения из списка.
 *
 * @param {unknown} messages — сообщения шага.
 * @returns {Array<object>} только human/user-сообщения.
 */
function humanMessages(messages) {
  if (!Array.isArray(messages)) return []
  return messages.filter((message) => message?.role === 'user' && message?.source?.kind === 'user')
}

/**
 * Последнее пользовательское сообщение в логе сессии.
 *
 * @param {object | undefined} agent — агент хода.
 * @returns {string} текст или пустая строка.
 */
export function lastUserMessageFromSession(agent) {
  const events = agent?.session?.events
  if (!Array.isArray(events)) return ''
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    return messageText(event.data)
  }
  return ''
}
