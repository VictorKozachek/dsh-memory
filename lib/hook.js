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
 * (`ctx.effect`).
 *
 * @module dsh-memory/hook
 */

import { randomUUID } from 'node:crypto'

import { resolveNamespace } from './config.js'
import { buildMemoryBlock, injectionEnabled } from './inject.js'
import { openStore } from './store.js'

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
 * @param {(level: 'debug' | 'info' | 'warn', message: string) => void} [options.log] — лог.
 * @returns {{ handler: Function, close: () => void } | null} зарегистрированный хук или null, если контекст не умеет `on`.
 */
export function registerMemoryInjection(ctx, { config = {}, env = process.env, log = () => {} } = {}) {
  if (typeof ctx?.on !== 'function') return null

  const dbPath = config.db_path ?? '~/.dsh/memory'
  const namespace = config.namespace ?? 'auto'
  const topK = config.inject?.top_k ?? 3
  const tokenBudget = config.inject?.token_budget ?? 600
  const snippetChars = config.search?.snippet_chars ?? 300
  const configEnabled = config.inject?.enabled ?? true

  /** @type {Map<string, import('./store.js').MemoryStore>} */
  const stores = new Map()

  /** Открыть/взять хранилище для воркспейса сессии. */
  const storeFor = (workspace) => {
    const name = resolveNamespace(namespace, workspace)
    let store = stores.get(name)
    if (store === undefined) {
      store = openStore({ dbPath, namespace: name })
      stores.set(name, store)
      log('debug', `хранилище памяти открыто: namespace "${name}"`)
    }
    return store
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
      const result = buildMemoryBlock(storeFor(workspace), message, {
        topK,
        tokenBudget,
        snippetChars,
        env,
        configEnabled,
      })
      if (result.block === null) return decision
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
