/**
 * Регистрация `memory.*` в `ctx.tools` (задача 031).
 *
 * Модули памяти уже есть; здесь — model-facing инструменты DSH:
 * `memory.search`, `memory.write`, `memory.verify`, `memory.invalidate`,
 * `memory.stats`. Регистрация опциональна: если сервиса `tools` нет, плагин
 * работает как раньше. Схемы входа/выхода повторяют README §Инструменты;
 * namespace берётся из воркспейса хода (`exec.agent.session.header.cwd`).
 *
 * `defineTool` берётся из `@deepseek-ai/dsh-tools`, если пакет доступен; без
 * него используется компилирующий фолбэк: author-DSL → raw JSON Schema
 * (required:true → массив required), плюс валидация аргументов перед execute.
 * Так fallback-путь при установке через `link:` тоже даёт валидный
 * ToolDefinition. Ошибки execute не глотаются: registry DSH превращает их в
 * ошибку инструмента, не завершая ход.
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
  // Пакет DSH не установлен в тестах/standalone; ниже компилирующий фолбэк.
}

/**
 * Скомпилировать author-DSL в raw JSON Schema (как `defineTool` из DSH).
 * Нужен для fallback-пути: `ToolRuntime` принимает только raw-схемы, а
 * per-property `required:true` — синтаксис author-DSL.
 *
 * @param {object} spec — author-схема.
 * @returns {object} raw JSON Schema.
 */
export function compileValueSchema(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('dsh-memory: схема инструмента должна быть объектом')
  }
  const output = {}
  for (const key of ['description', 'title', 'default', 'examples']) {
    if (Object.hasOwn(spec, key)) output[key] = spec[key]
  }
  if (Object.hasOwn(spec, 'oneOf')) {
    output.oneOf = spec.oneOf.map((branch) => compileValueSchema(branch))
    return output
  }
  const type = spec.type
  if (type === 'object') {
    output.type = 'object'
    output.additionalProperties = spec.additionalProperties ?? true
    if (Object.hasOwn(spec, 'properties')) {
      const compiled = compilePropertyMap(spec.properties)
      output.properties = compiled.properties
      if (compiled.required !== undefined) output.required = compiled.required
    }
    return output
  }
  if (type === 'array') {
    output.type = 'array'
    if (Object.hasOwn(spec, 'items')) output.items = compileValueSchema(spec.items)
    return output
  }
  if (type === 'json') return output
  if (!['string', 'number', 'integer', 'boolean', 'null'].includes(type)) {
    throw new TypeError(`dsh-memory: неподдерживаемый тип схемы ${JSON.stringify(type)}`)
  }
  output.type = type
  if (Object.hasOwn(spec, 'enum')) output.enum = [...spec.enum]
  if (Object.hasOwn(spec, 'const')) output.const = spec.const
  return output
}

/** Скомпилировать property-map параметров в raw object-схему. */
export function compileParameterSchema(parameters = {}) {
  const compiled = compilePropertyMap(parameters)
  return {
    type: 'object',
    properties: compiled.properties,
    ...(compiled.required === undefined ? {} : { required: compiled.required }),
  }
}

/** Скомпилировать author property-map: required:true → массив required. */
function compilePropertyMap(properties) {
  const compiled = {}
  const required = []
  for (const [key, spec] of Object.entries(properties)) {
    compiled[key] = compileValueSchema(spec)
    if (spec?.required === true) required.push(key)
  }
  return { properties: compiled, ...(required.length === 0 ? {} : { required }) }
}

/** Скомпилировать author-definition в registry-ready raw ToolDefinition. */
export function compileToolDefinition(definition) {
  return {
    ...definition,
    parameters: compileParameterSchema(definition.parameters),
    output: {
      ...definition.output,
      schema: compileValueSchema(definition.output.schema),
    },
  }
}

/**
 * Фолбэк, если официальный `defineTool` недоступен: компилирует DSL в raw
 * JSON Schema и валидирует аргументы перед execute (в fallback-режиме DSH
 * raw-инструмент не валидирует их сам).
 */
const fallbackDefineTool = (definition) => {
  const compiled = compileToolDefinition(definition)
  const validate = (args) => validateArguments(definition.parameters ?? {}, args)
  const execute = compiled.execute
  compiled.execute = async (args, exec) => {
    const violations = validate(args)
    if (violations.length > 0) throw new TypeError(`invalid arguments: ${violations.join('; ')}`)
    return execute(args, exec)
  }
  return compiled
}

/** Официальный defineTool или компилирующий фолбэк. */
export const defaultDefineTool = typeof officialDefineTool === 'function'
  ? officialDefineTool
  : fallbackDefineTool

/** Простая валидация аргументов для fallback-пути. */
function validateArguments(parameters, args) {
  const violations = []
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ['arguments must be an object']
  for (const [key, spec] of Object.entries(parameters)) {
    const value = args[key]
    if (value === undefined) {
      if (spec?.required === true) violations.push(`${key} is required`)
      continue
    }
    validateValue(spec, value, key, violations)
  }
  return violations
}

/** Проверить значение по author-схеме. */
function validateValue(spec, value, path, violations) {
  if (spec === null || typeof spec !== 'object') return
  if (Object.hasOwn(spec, 'oneOf')) {
    const matched = spec.oneOf.some((branch) => {
      const nested = []
      validateValue(branch, value, path, nested)
      return nested.length === 0
    })
    if (!matched) violations.push(`${path} does not match oneOf`)
    return
  }
  const type = spec.type
  if (type === 'string' && typeof value !== 'string') violations.push(`${path} must be a string`)
  else if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) violations.push(`${path} must be a number`)
  else if (type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) violations.push(`${path} must be an integer`)
  else if (type === 'boolean' && typeof value !== 'boolean') violations.push(`${path} must be a boolean`)
  else if (type === 'null' && value !== null) violations.push(`${path} must be null`)
  else if (type === 'array') {
    if (!Array.isArray(value)) violations.push(`${path} must be an array`)
    else if (spec.items !== undefined) value.forEach((item, index) => validateValue(spec.items, item, `${path}[${index}]`, violations))
  } else if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) violations.push(`${path} must be an object`)
    else if (spec.properties !== undefined) {
      for (const [key, child] of Object.entries(spec.properties)) {
        if (value[key] === undefined) {
          if (child.required === true) violations.push(`${path}.${key} is required`)
        } else validateValue(child, value[key], `${path}.${key}`, violations)
      }
    }
  }
  if (Array.isArray(spec.enum) && !spec.enum.includes(value)) violations.push(`${path} must be one of ${JSON.stringify(spec.enum)}`)
}

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
