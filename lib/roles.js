/**
 * Реестр ролей и прототип диспетчера сабмоделей (задача 018, фаза 5).
 *
 * Диспетчер — отдельный слой над L2: получает ход после промаха L0/L1, делит
 * на подтемы, маршрутизирует их ролям (developer/designer/reviewer/tester/
 * scientist и т.п.), собирает ответы и агрегирует. Здесь только прототип на
 * моках: план подтем задаётся явно или простым planner-ом, провайдеры
 * инжектируются, память/DSH не затрагиваются. Дизайн — `docs/roles-design.md`.
 *
 * @module dsh-memory/roles
 */

/** Допустимое имя роли. */
export const ROLE_NAME = /^[a-z][a-z0-9-]*$/u

/** Роли из README (для документации/примеров); реестр создаётся конфигом. */
export const ROLE_NAMES = Object.freeze(['developer', 'designer', 'reviewer', 'tester', 'scientist'])

/** Ошибка таймаута planner (fallback на L3, не исключение для хода). */
export class PlannerTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`planner не ответил за ${timeoutMs} мс`)
    this.name = 'PlannerTimeoutError'
  }
}

/** Ошибка контракта плана (fallback на L3, не исключение для хода). */
export class PlanError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PlanError'
  }
}

/**
 * Проверить и нормализовать роль.
 *
 * @param {object} role — описание роли.
 * @param {string} role.name — имя.
 * @param {string} role.prompt — промпт роли.
 * @param {string} role.model — id модели.
 * @param {string} role.namespace — namespace памяти.
 * @param {string[]} [role.responsibilities] — зоны ответственности (для маршрутизации).
 * @param {number} [role.priority] — меньше — важнее (дефолт 100).
 * @param {number} [role.max_tokens] — лимит ответа.
 * @param {number} [role.timeout_ms] — таймаут роли.
 * @param {boolean} [role.enabled] — включена ли роль.
 * @returns {Readonly<object>} нормализованная роль.
 */
export function validateRole(role) {
  if (role === null || typeof role !== 'object' || Array.isArray(role)) {
    throw new TypeError('dsh-memory: роль должна быть объектом')
  }
  const name = typeof role.name === 'string' ? role.name.trim() : ''
  if (!ROLE_NAME.test(name)) {
    throw new TypeError(`dsh-memory: имя роли должно соответствовать ${ROLE_NAME}; получено ${JSON.stringify(role.name)}`)
  }
  for (const field of ['prompt', 'model', 'namespace']) {
    if (typeof role[field] !== 'string' || role[field].trim() === '') {
      throw new TypeError(`dsh-memory: у роли "${name}" поле ${field} должно быть непустой строкой`)
    }
  }
  const responsibilities = Array.isArray(role.responsibilities)
    ? role.responsibilities.map((value) => {
      if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`dsh-memory: у роли "${name}" responsibilities должны быть непустыми строками`)
      return value.trim()
    })
    : []
  const priority = role.priority === undefined ? 100 : role.priority
  if (!Number.isSafeInteger(priority) || priority < 0) throw new TypeError(`dsh-memory: у роли "${name}" priority должен быть целым ≥ 0`)
  const maxTokens = role.max_tokens === undefined ? undefined : role.max_tokens
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) {
    throw new TypeError(`dsh-memory: у роли "${name}" max_tokens должен быть целым ≥ 1`)
  }
  const timeout = role.timeout_ms === undefined ? undefined : role.timeout_ms
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1)) {
    throw new TypeError(`dsh-memory: у роли "${name}" timeout_ms должен быть целым ≥ 1`)
  }
  return Object.freeze({
    name,
    prompt: role.prompt.trim(),
    model: role.model.trim(),
    namespace: role.namespace.trim(),
    responsibilities: Object.freeze(responsibilities),
    priority,
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    ...(timeout === undefined ? {} : { timeout_ms: timeout }),
    enabled: role.enabled !== false,
  })
}

/**
 * Создать реестр ролей. Имена уникальны; невалидная роль — ошибка конфигурации
 * (вызывающий решает, отключить диспетчер или упасть на старте).
 *
 * @param {object[]} [roles] — роли.
 * @returns {{ add: Function, get: Function, list: Function, has: Function, size: number }} реестр.
 */
export function createRoleRegistry(roles = []) {
  const byName = new Map()
  const registry = {
    add(role) {
      const normalized = validateRole(role)
      if (byName.has(normalized.name)) throw new Error(`dsh-memory: роль "${normalized.name}" уже зарегистрирована`)
      byName.set(normalized.name, normalized)
      return normalized
    },
    get(name) {
      return byName.get(String(name)) ?? null
    },
    has(name) {
      return byName.has(String(name))
    },
    list() {
      return [...byName.values()].sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name))
    },
    get size() {
      return byName.size
    },
  }
  for (const role of roles) registry.add(role)
  return registry
}

/**
 * Слить ответы ролей по подтеме.
 *
 * @param {Array<{ role: string, answer?: string, confidence?: number, sources?: unknown[], priority?: number, error?: string }>} results — результаты.
 * @param {{ strategy?: 'single'|'priority'|'concat'|'vote', rolePriority?: string[] }} [options] — стратегия.
 * @returns {{ answer: string|null, role: string|null, confidence: number, sources: unknown[], conflicts: string[], fallback: boolean }} агрегат.
 */
export function aggregateResults(results = [], { strategy = 'priority', rolePriority = [] } = {}) {
  const successful = results.filter((result) => typeof result?.answer === 'string' && result.answer.trim() !== '' && !result.error)
  if (successful.length === 0) {
    return { answer: null, role: null, confidence: 0, sources: [], conflicts: [], fallback: true }
  }
  const normalized = successful.map((result) => ({ ...result, answer: result.answer.trim(), confidence: Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : 0 }))
  const conflicts = [...new Set(normalized.map((result) => result.answer.toLowerCase()))]

  if (strategy === 'single' || successful.length === 1) {
    const [winner] = normalized
    return finish(winner, conflicts)
  }
  if (strategy === 'concat') {
    const answer = normalized.map((result) => `[${result.role}] ${result.answer}`).join('\n\n')
    return { answer, role: null, confidence: Math.max(...normalized.map((result) => result.confidence)), sources: normalized.flatMap((result) => result.sources ?? []), conflicts, fallback: false }
  }
  if (strategy === 'vote') {
    const counts = new Map()
    for (const result of normalized) {
      const key = result.answer.toLowerCase()
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const best = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]
    const tied = [...counts.values()].filter((count) => count === best[1]).length > 1
    const winner = tied
      ? pickPriority(normalized, rolePriority)
      : normalized.find((result) => result.answer.toLowerCase() === best[0])
    return finish(winner, conflicts)
  }
  return finish(pickPriority(normalized, rolePriority), conflicts)
}

/** Выбрать ответ по priority роли, затем confidence, числу источников, имени. */
function pickPriority(results, rolePriority) {
  return [...results].sort((left, right) => {
    const leftRank = rankOf(left.role, rolePriority) - rankOf(right.role, rolePriority)
    if (leftRank !== 0) return leftRank
    const leftPriority = Number.isFinite(left.priority) ? left.priority : 100
    const rightPriority = Number.isFinite(right.priority) ? right.priority : 100
    if (leftPriority !== rightPriority) return leftPriority - rightPriority
    if (left.confidence !== right.confidence) return right.confidence - left.confidence
    const sources = (right.sources?.length ?? 0) - (left.sources?.length ?? 0)
    if (sources !== 0) return sources
    return String(left.role).localeCompare(String(right.role))
  })[0]
}

/** Индекс роли в явном rolePriority (иначе большой). */
function rankOf(role, rolePriority) {
  const index = rolePriority.indexOf(role)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

/** Собрать итог агрегации. */
function finish(winner, conflicts) {
  return {
    answer: winner.answer,
    role: winner.role,
    confidence: winner.confidence,
    sources: winner.sources ?? [],
    conflicts: conflicts.length > 1 ? conflicts : [],
    fallback: false,
  }
}

/**
 * Создать диспетчер на моках.
 *
 * @param {object} options — параметры.
 * @param {ReturnType<typeof createRoleRegistry>} options.registry — реестр ролей.
 * @param {Record<string, Function>} [options.providers] — провайдеры ролей `({role, subtopic, signal}) => {answer, confidence, sources}`.
 * @param {{ strategy?: string, timeout_ms?: number, rolePriority?: string[], defaultRole?: string, planTimeoutMs?: number, maxSubtasks?: number }} [options.config] — настройки.
 * @param {(level: string, message: string) => void} [options.logger] — лог.
 * @returns {{ dispatch: Function, registry: object }} диспетчер.
 */
export function createDispatcher({ registry, providers = {}, config = {}, logger = () => {} } = {}) {
  if (!registry || typeof registry.get !== 'function' || typeof registry.list !== 'function') {
    throw new TypeError('dsh-memory: диспетчеру нужен реестр ролей')
  }
  const strategy = config.strategy ?? 'priority'
  const timeoutMs = Number.isSafeInteger(config.timeout_ms) && config.timeout_ms > 0 ? config.timeout_ms : 5_000
  const planTimeoutMs = Number.isSafeInteger(config.planTimeoutMs) && config.planTimeoutMs > 0 ? config.planTimeoutMs : 5_000
  const maxSubtasks = Number.isSafeInteger(config.maxSubtasks) && config.maxSubtasks > 0 ? config.maxSubtasks : 8

  return {
    registry,
    /**
     * Выполнить ход: план подтем → роли → агрегация.
     *
     * @param {{ task: string, subtopics?: Array<{ id?: string, text: string, role?: string }>, planner?: Function, signal?: AbortSignal }} input — вход.
     * @returns {Promise<{ subtopics: object[], results: object[], answers: object[], answer: string|null, role: string|null, confidence: number, sources: unknown[], conflicts: string[], fallback: boolean }>} результат.
     */
    async dispatch({ task, subtopics, planner, signal } = {}) {
      if (typeof task !== 'string' || task.trim() === '') throw new TypeError('dsh-memory: dispatch ждёт непустой task')
      if (signal?.aborted) throw abortError()
      let plan
      try {
        plan = await resolvePlan({
          task,
          subtopics,
          planner,
          registry,
          defaultRole: config.defaultRole,
          signal,
          planTimeoutMs,
          maxSubtasks,
        })
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw abortError()
        if (error instanceof PlanError || error instanceof PlannerTimeoutError) {
          logger('warn', `dispatch: план не принят (${error.message})`)
          return emptyResult([], [])
        }
        throw error
      }
      if (plan.length === 0) return emptyResult([], [])

      const results = await Promise.all(plan.map(async (subtopic) => {
        const role = registry.get(subtopic.role)
        if (role === null || role.enabled === false) {
          return { subtopic, role: subtopic.role ?? null, answer: '', confidence: 0, sources: [], error: 'unknown or disabled role' }
        }
        const provider = providers[role.name]
        if (typeof provider !== 'function') {
          return { subtopic, role: role.name, answer: '', confidence: 0, sources: [], error: 'no provider' }
        }
        try {
          const reply = await callWithTimeout(
            (signalRole) => provider({ role, subtopic, signal: signalRole }),
            role.timeout_ms ?? timeoutMs,
            signal,
          )
          if (typeof reply?.answer !== 'string' || reply.answer.trim() === '') {
            return { subtopic, role: role.name, answer: '', confidence: 0, sources: [], error: 'empty answer' }
          }
          return {
            subtopic,
            role: role.name,
            priority: role.priority,
            answer: reply.answer.trim(),
            confidence: Number.isFinite(Number(reply.confidence)) ? Number(reply.confidence) : 0,
            sources: Array.isArray(reply.sources) ? reply.sources : [],
            ...(reply.namespace === undefined ? {} : { namespace: reply.namespace }),
          }
        } catch (error) {
          if (signal?.aborted || error?.name === 'AbortError') throw abortError()
          logger('warn', `dispatch: роль ${role.name} не ответила: ${error instanceof Error ? error.message : String(error)}`)
          return { subtopic, role: role.name, answer: '', confidence: 0, sources: [], error: 'provider failed' }
        }
      }))

      const answers = []
      const allConflicts = []
      for (const subtopic of plan) {
        const group = results.filter((result) => result.subtopic.id === subtopic.id)
        const aggregated = aggregateResults(group, { strategy, rolePriority: config.rolePriority ?? [] })
        if (!aggregated.fallback) {
          answers.push({ subtopicId: subtopic.id, ...aggregated })
          allConflicts.push(...aggregated.conflicts)
        }
      }

      if (answers.length === 0) return emptyResult(results, plan)
      const answer = answers.length === 1 ? answers[0].answer : answers.map((item) => `[${item.role ?? item.subtopicId}] ${item.answer}`).join('\n\n')
      return {
        subtopics: plan,
        results,
        answers,
        answer,
        role: answers.length === 1 ? answers[0].role : null,
        confidence: Math.min(...answers.map((item) => item.confidence)),
        sources: answers.flatMap((item) => item.sources),
        conflicts: [...new Set(allConflicts)],
        fallback: false,
      }
    },
  }
}

/** Построить и провалидировать план подтем. */
async function resolvePlan({ task, subtopics, planner, registry, defaultRole, signal, planTimeoutMs, maxSubtasks }) {
  if (subtopics !== undefined) {
    return normalizePlan(subtopics, { registry, defaultRole, maxSubtasks })
  }
  if (typeof planner === 'function') {
    const planned = await callPlanner(planner, { task, registry, signal }, planTimeoutMs, signal)
    return normalizePlan(planned, { registry, defaultRole, maxSubtasks })
  }
  const role = defaultRole ?? routeRole(registry, task, defaultRole)
  return role === null ? [] : [{ id: 's1', text: task, role }]
}

/**
 * Провалидировать и нормализовать план. Битый план — PlanError (fallback L3).
 *
 * @param {unknown} planned — ответ planner/явные подтемы.
 * @param {{ registry: object, defaultRole?: string, maxSubtasks: number }} options — контекст.
 * @returns {object[]} подтемы (не больше maxSubtasks).
 */
function normalizePlan(planned, { registry, defaultRole, maxSubtasks }) {
  if (!Array.isArray(planned)) throw new PlanError('planner должен вернуть массив подтем')
  if (planned.length === 0) return []
  const plan = []
  for (let index = 0; index < planned.length && plan.length < maxSubtasks; index += 1) {
    const item = planned[index]
    let text
    let role
    let id = `s${index + 1}`
    if (typeof item === 'string') {
      text = item.trim()
    } else if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      text = typeof item.text === 'string' ? item.text.trim() : ''
      role = item.role
      if (typeof item.id === 'string' && item.id.trim() !== '') id = item.id.trim()
      if (typeof role !== 'string' || role.trim() === '') throw new PlanError(`подтема ${id} должна иметь role`)
    } else {
      throw new PlanError(`подтема ${index + 1} должна быть строкой или объектом с role`)
    }
    if (text === '') throw new PlanError(`подтема ${id} пустая`)
    const normalizedRole = role?.trim() || defaultRole || routeRole(registry, text, defaultRole)
    plan.push({ id, text, role: normalizedRole ?? null })
  }
  return plan
}

/**
 * Вызвать planner с таймаутом и отменой хода.
 *
 * @param {Function} planner — planner.
 * @param {object} input — аргументы planner.
 * @param {number} timeoutMs — таймаут.
 * @param {AbortSignal | undefined} outer — отмена хода.
 * @returns {Promise<unknown>} план.
 */
async function callPlanner(planner, input, timeoutMs, outer) {
  if (outer?.aborted) throw abortError()
  let timer
  let onAbort
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new PlannerTimeoutError(timeoutMs)), timeoutMs)
  })
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError())
    if (typeof outer?.addEventListener === 'function') outer.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([planner(input), timeout, aborted])
  } finally {
    clearTimeout(timer)
    if (onAbort !== undefined && typeof outer?.removeEventListener === 'function') outer.removeEventListener('abort', onAbort)
  }
}

/** Простейшая маршрутизация по responsibilities (мок; будущий planner — 018/фаза 5). */
function routeRole(registry, text, defaultRole) {
  if (typeof defaultRole === 'string' && registry.has(defaultRole)) return defaultRole
  const lower = String(text ?? '').toLowerCase()
  const match = registry.list().find((role) => role.enabled && role.responsibilities.some((item) => lower.includes(item.toLowerCase())))
  return match?.name ?? null
}

/** Пустой результат с fallback на L3. */
function emptyResult(results, subtopics) {
  return { subtopics, results, answers: [], answer: null, role: null, confidence: 0, sources: [], conflicts: [], fallback: true }
}

/** Таймаут/отмена роли. */
async function callWithTimeout(call, timeoutMs, outer) {
  if (outer?.aborted) throw abortError()
  const controller = new AbortController()
  let timer
  let onOuterAbort
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error(`таймаут роли ${timeoutMs} мс`)) }, timeoutMs)
    timer.unref?.()
  })
  const aborted = new Promise((_, reject) => {
    onOuterAbort = () => { controller.abort(); reject(abortError()) }
    if (typeof outer?.addEventListener === 'function') outer.addEventListener('abort', onOuterAbort, { once: true })
  })
  try {
    return await Promise.race([call(controller.signal), timeout, aborted])
  } catch (error) {
    if (outer?.aborted) throw abortError()
    if (controller.signal.aborted) throw new Error(`таймаут роли ${timeoutMs} мс`)
    throw error
  } finally {
    clearTimeout(timer)
    if (onOuterAbort !== undefined && typeof outer?.removeEventListener === 'function') outer.removeEventListener('abort', onOuterAbort)
  }
}

/** AbortError. */
function abortError() {
  const error = new Error('dsh-memory: диспетчер отменён')
  error.name = 'AbortError'
  return error
}
