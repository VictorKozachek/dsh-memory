/**
 * Регистрация `memory.*` в `ctx.tools` (задача 031).
 *
 * Модули памяти уже есть; здесь — model-facing инструменты DSH:
 * `memory.search`, `memory.write`, `memory.verify`, `memory.invalidate`,
 * `memory.stats`. Регистрация опциональна: если сервиса `tools` нет, плагин
 * работает как раньше. Схемы входа/выхода повторяют README §Инструменты;
 * namespace берётся из воркспейса хода (`exec.agent.session.header.cwd`).
 *
 * `defineTool` берётся из `@deepseek-ai/dsh-tools`, если пакет доступен; в
 * тестах/сборке без него используется identity-фолбэк (definition уже
 * соответствует контракту ToolDefinition). Ошибки execute не глотаются:
 * registry DSH превращает их в ошибку инструмента, не завершая ход.
 *
 * @module dsh-memory/tools
 */

import { ENTRY_KINDS } from './write.js'
import { invalidateMemory } from './invalidate.js'
import { memoryStats } from './metrics.js'
import { verifyMemory } from './verify.js'
import { writeMemory } from './write.js'

let officialDefineTool
try {
  const module = await import('@deepseek-ai/dsh-tools')
  officialDefineTool = module.defineTool
} catch {
  // Пакет DSH не установлен в тестах/standalone; identity сохраняет контракт.
}

/** Identity-фолбэк, если официальный defineTool недоступен. */
export const defaultDefineTool = typeof officialDefineTool === 'function'
  ? officialDefineTool
  : (definition) => definition

/** Рабочий каталог хода. */
function workspaceOf(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd()
}

/** Nullable-поле (source_path/source_ref/перцентили без данных). */
const nullable = (type) => ({ oneOf: [{ type }, { type: 'null' }] })

/** Схема одной записи поиска (контракт README). */
const SEARCH_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'number', required: true },
    title: { type: 'string', required: true },
    snippet: { type: 'string', required: true, description: '≤ 300 chars' },
    source_path: nullable('string'),
    source_ref: nullable('string'),
    status: { type: 'string', required: true, enum: ['verified', 'draft'] },
    confidence: { type: 'number', required: true },
    score: { type: 'number', required: true },
  },
}

/** Схема памяти для stats (контракт README + dispatch из 028). */
const STATS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    entries: { type: 'number', required: true },
    by_status: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        draft: { type: 'number', required: true },
        verified: { type: 'number', required: true },
        stale: { type: 'number', required: true },
      },
    },
    hit_rate: { type: 'number', required: true },
    injected_tokens: { type: 'number', required: true },
    tokens_saved_estimate: { type: 'number', required: true },
    dispatch: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        count: { type: 'number', required: true },
        fallback_rate: { type: 'number', required: true },
        p50_ms: nullable('number'),
        p95_ms: nullable('number'),
        by_role: { type: 'object', additionalProperties: true },
      },
    },
  },
}

/**
 * Зарегистрировать пять инструментов в `ctx.tools`.
 *
 * @param {object} options — параметры.
 * @param {{ register: Function }} options.tools — реестр инструментов DSH.
 * @param {object} options.memory — сервис `ctx.memory`.
 * @param {Function} [options.defineTool] — фабрика ToolDefinition (по умолчанию официальная/identity).
 * @param {(level: string, message: string) => void} [options.log] — лог.
 * @returns {Array<() => void>} функции снятия регистраций.
 */
export function registerMemoryTools({ tools, memory, defineTool = defaultDefineTool, log = () => {} } = {}) {
  if (!tools || typeof tools.register !== 'function') return []
  if (!memory || typeof memory.storeFor !== 'function' || typeof memory.search !== 'function') {
    throw new TypeError('dsh-memory: для memory.* нужен сервис memory')
  }
  const disposers = []
  const register = (definition) => {
    try {
      const dispose = tools.register(defineTool(definition))
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      log('warn', `инструмент ${definition.name} не зарегистрирован: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  register({
    name: 'memory.search',
    description: 'Search project memory. By default returns verified entries only; snippets are at most 300 chars. Use status:"all" to include drafts.',
    parameters: {
      query: { type: 'string', required: true, description: 'What to search for.' },
      k: { type: 'number', description: 'Maximum results (default 10).' },
      kinds: { type: 'array', items: { type: 'string', enum: [...ENTRY_KINDS] }, description: 'Optional entry kinds.' },
      status: { type: 'string', enum: ['verified', 'all'], description: 'verified (default) or all (with drafts).' },
      namespace: { type: 'string', description: 'Optional namespace filter; defaults to the turn workspace.' },
    },
    output: {
      schema: { type: 'array', items: SEARCH_ITEM_SCHEMA },
      render: (_args, value) => [{ type: 'text', text: Array.isArray(value) && value.length > 0 ? value.map((item) => `[memory] ${item.title} — ${item.snippet}`).join('\n') : 'No memory results.' }],
    },
    async execute(args, exec) {
      return memory.search(args, { workspace: workspaceOf(exec) })
    },
  })

  register({
    name: 'memory.write',
    description: 'Write a draft knowledge entry to project memory. Always draft (never verified), model entries are capped at confidence 0.6; include a source.',
    parameters: {
      text: { type: 'string', required: true, description: 'Full text of the knowledge.' },
      title: { type: 'string', required: true, description: 'Short title.' },
      kind: { type: 'string', required: true, enum: [...ENTRY_KINDS], description: 'Entry kind.' },
      sources: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Provenance: [{ path? , ref? }].' },
      confidence: { type: 'number', description: '0..1; without a source must be <0.5, model entries cap at 0.6.' },
      status: { type: 'string', enum: ['draft'], description: 'Only draft; verified is set by memory.verify.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'number', required: true },
          deduped: { type: 'boolean', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Memory ${value.deduped ? 'deduplicated' : 'written'}: id=${value.id}, status=${value.status}.` }],
    },
    async execute(args, exec) {
      const result = writeMemory(memory.storeFor(workspaceOf(exec)), {
        ...args,
        status: 'draft',
        author: 'model:memory.write',
      })
      return { id: result.id, deduped: result.deduped, status: result.status }
    },
  })

  register({
    name: 'memory.verify',
    description: 'Confirm a draft memory entry. Requires provenance by default; verified_by must be reviewer/verifier/tester or human.',
    parameters: {
      id: { type: 'number', required: true, description: 'Entry id.' },
      verified_by: { type: 'string', required: true, description: 'reviewer:…, verifier:…, tester:… or human.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'number', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Memory entry ${value.id}: ${value.status}.` }],
    },
    async execute(args, exec) {
      return verifyMemory(memory.storeFor(workspaceOf(exec)), args)
    },
  })

  register({
    name: 'memory.invalidate',
    description: 'Mark memory entries stale by source path or ref. Stale entries are never returned by search.',
    parameters: {
      path: { type: 'string', description: 'Workspace file path.' },
      ref: { type: 'string', description: 'Commit/task/URL reference.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { affected: { type: 'number', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `Marked ${value.affected} memory entries stale.` }],
    },
    async execute(args, exec) {
      return invalidateMemory(memory.storeFor(workspaceOf(exec)), args)
    },
  })

  register({
    name: 'memory.stats',
    description: 'Return memory statistics: entries, statuses, hit rate, injected tokens, saved tokens and dispatcher metrics.',
    parameters: {},
    output: {
      schema: STATS_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `Memory: ${value.entries} entries, hit_rate=${value.hit_rate}, saved≈${value.tokens_saved_estimate}.` }],
    },
    async execute(_args, exec) {
      return memoryStats(memory.storeFor(workspaceOf(exec)))
    },
  })

  return disposers
}
