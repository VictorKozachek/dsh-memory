/**
 * Живая обвязка диспетчера ролей (задача 025, спека 003).
 *
 * `lib/roles.js` — прототип реестра/маршрутизации. Здесь он превращается в
 * слой, который может вызвать hook после промаха L1: реестр собирается из
 * `dispatcher.roles`, провайдеры ролей и planner регистрируются адаптером
 * (DSH-модели, тесты), а флаг `dispatcher.enabled` по умолчанию выключен.
 *
 * Никаких сетевых/DSH-зависимостей: пока провайдер не зарегистрирован, план
 * не покрыт и ход уходит на L3. Ошибка роли/диспетчера превращается в
 * fallback с причиной, а не в исключение.
 *
 * @module dsh-memory/live-dispatcher
 */

import { createDispatcher, createRoleRegistry } from './roles.js'

/**
 * Создать живой диспетчер из разрешённого конфига.
 *
 * @param {object} [options] — параметры.
 * @param {object} [options.config] — разрешённый конфиг плагина (`dispatcher`).
 * @param {(level: 'debug'|'info'|'warn', message: string) => void} [options.logger] — лог без текста запроса.
 * @returns {{
 *   enabled: boolean,
 *   registry: object|null,
 *   registerProvider: (name: string, provider: Function) => () => void,
 *   registerPlanner: (planner: Function) => () => void,
 *   dispatch: (input: { task: string, signal?: AbortSignal }) => Promise<object>,
 * }} диспетчер.
 */
export function createLiveDispatcher({ config = {}, logger = () => {} } = {}) {
  const settings = config?.dispatcher ?? {}
  const flag = settings.enabled === true
  let registry = null
  let invalidReason = ''
  if (Array.isArray(settings.roles) && settings.roles.length > 0) {
    try {
      registry = createRoleRegistry(settings.roles)
    } catch (error) {
      invalidReason = `реестр ролей невалиден: ${error instanceof Error ? error.message : String(error)}`
      logger('warn', `dispatcher: ${invalidReason}`)
    }
  } else {
    invalidReason = 'роли не заданы'
  }

  const enabled = flag && registry !== null && registry.size > 0

  /** Провайдеры пополняются адаптером после apply; объект живёт в замыкании. */
  const providers = {}
  let planner = null
  const dispatcher = enabled
    ? createDispatcher({
      registry,
      providers,
      config: {
        strategy: settings.strategy ?? 'priority',
        timeout_ms: settings.timeout_ms,
        defaultRole: settings.default_role === '' ? undefined : settings.default_role,
        planTimeoutMs: settings.plan_timeout_ms,
        maxSubtasks: settings.max_subtasks,
      },
      logger,
    })
    : null

  const live = {
    enabled,
    registry,
    /** Зарегистрировать провайдера роли; возвращает снятие. */
    registerProvider(name, provider) {
      if (typeof name !== 'string' || name.trim() === '') throw new TypeError('dsh-memory: имя роли провайдера непустое')
      if (typeof provider !== 'function') throw new TypeError('dsh-memory: провайдер роли должен быть функцией')
      providers[name] = provider
      return () => {
        if (providers[name] === provider) delete providers[name]
      }
    },
    /** Зарегистрировать planner подтем; возвращает снятие. */
    registerPlanner(fn) {
      if (typeof fn !== 'function') throw new TypeError('dsh-memory: planner должен быть функцией')
      planner = fn
      return () => {
        if (planner === fn) planner = null
      }
    },
    /**
     * Выполнить диспетчер для хода.
     *
     * @param {{ task: string, signal?: AbortSignal }} input — запрос и отмена.
     * @returns {Promise<{ fallback: boolean, reason: string, answer?: string }>} ответ или fallback.
     */
    async dispatch({ task, signal } = {}) {
      if (!enabled) return { fallback: true, reason: flag ? invalidReason : 'dispatcher disabled' }
      if (signal?.aborted) return { fallback: true, reason: 'aborted' }
      try {
        const result = await dispatcher.dispatch({ task, ...(planner === null ? {} : { planner }), signal })
        const metadata = dispatchMetadata(result)
        if (result.fallback) {
          return { fallback: true, reason: fallbackReason(result), ...metadata }
        }
        return { fallback: false, reason: 'answer', answer: result.answer, role: result.role, confidence: result.confidence, sources: Array.isArray(result.sources) ? result.sources : [], ...metadata }
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw abortError()
        logger('warn', `dispatcher: ошибка выполнения (${error instanceof Error ? error.message : String(error)})`)
        return { fallback: true, reason: 'ошибка диспетчера' }
      }
    },
  }
  return live
}

/** Причина fallback без текста запроса; сохраняем timeout/provider failed. */
function fallbackReason(result) {
  if (typeof result?.reason === 'string' && result.reason.trim() !== '') return result.reason.trim()
  const errors = Array.isArray(result?.results) ? result.results.filter((item) => item.error !== undefined) : []
  if (errors.length === 0) return 'план не покрыт ролями'
  const timeouts = errors.filter((item) => item.error === 'role timeout').length
  const failed = errors.filter((item) => item.error !== 'role timeout').length
  return `роли не ответили: role timeout ${timeouts}, provider failed ${failed}`
}

/** Метаданные для metrics (028): без текста запроса/ответов. */
function dispatchMetadata(result) {
  const results = Array.isArray(result?.results) ? result.results : []
  const roles = [...new Set(results.map((item) => item.role).filter((role) => typeof role === 'string' && role !== ''))]
  const durationsMs = {}
  for (const item of results) {
    if (typeof item?.role !== 'string' || !Number.isFinite(Number(item.duration_ms))) continue
    durationsMs[item.role] = Number(item.duration_ms)
  }
  return {
    subtopics: Array.isArray(result?.subtopics) ? result.subtopics.length : 0,
    roles,
    durationsMs,
    strategy: result?.strategy ?? 'priority',
    latencyMs: Number.isFinite(Number(result?.latency_ms)) ? Number(result.latency_ms) : 0,
  }
}

/** AbortError для отменённого диспетчера. */
function abortError() {
  const error = new Error('dsh-memory: диспетчер отменён')
  error.name = 'AbortError'
  return error
}
