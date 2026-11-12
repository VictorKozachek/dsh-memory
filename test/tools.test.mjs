/**
 * Тесты регистрации `memory.*` в `ctx.tools` (задача 031): схемы, execute,
 * namespace хода, ошибки инструмента и опциональность без сервиса tools.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as plugin from '../lib/index.js'

/** Мок ctx.tools, запоминающий определения. */
function setup(t, { withTools = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-tools-'))
  const registered = []
  const disposers = []
  let memory
  const ctx = {
    on: () => {},
    effect: (callback) => { disposers.push(callback); return () => {} },
    provide: (name, service) => { if (name === 'memory') memory = service },
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
  }
  if (withTools) {
    ctx.tools = {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    }
  }
  plugin.apply(ctx, { db_path: dir, namespace: 'demo' })
  t.after(() => {
    try { memory.storeFor(process.cwd()).close() } catch {}
    rmSync(dir, { recursive: true, force: true })
  })
  const byName = new Map(registered.map((definition) => [definition.name, definition]))
  const exec = { agent: { session: { header: { cwd: dir } } } }
  return { dir, memory, registered, byName, exec }
}

test('apply регистрирует пять memory.* с входными схемами и описаниями', (t) => {
  const { registered, byName } = setup(t)
  assert.deepEqual(registered.map((definition) => definition.name).sort(), [
    'memory_invalidate',
    'memory_search',
    'memory_stats',
    'memory_verify',
    'memory_write',
  ])
  for (const definition of registered) {
    assert.match(definition.name, /^[a-zA-Z0-9_-]+$/, `имя инструмента ${definition.name} должно проходить API-паттерн`)
  }

  const search = byName.get('memory_search')
  assert.equal(search.parameters.type, 'object')
  assert.ok(search.parameters.required.includes('query'))
  assert.deepEqual(search.parameters.properties.status.enum, ['verified', 'all'])
  assert.match(search.description, /verified/i)
  const item = search.output.schema.items
  assert.deepEqual(Object.keys(item.properties).sort(), [
    'confidence', 'id', 'score', 'snippet', 'source_path', 'source_ref', 'status', 'title',
  ])
  assert.deepEqual(item.required.sort(), ['confidence', 'id', 'score', 'snippet', 'status', 'title'])
  assert.ok(item.required.includes('id'))
  assert.ok(item.required.includes('title'))
  assert.ok(item.required.includes('snippet'))
  assert.deepEqual(item.properties.source_path.oneOf.map((branch) => branch.type), ['string', 'null'])
  assert.deepEqual(item.properties.status.enum, ['verified', 'draft'])
  const statsSchema = byName.get('memory_stats').output.schema
  assert.deepEqual(Object.keys(statsSchema.properties).sort(), [
    'by_status', 'dispatch', 'entries', 'hit_rate', 'injected_tokens', 'tokens_saved_estimate',
  ])
  assert.ok(statsSchema.required.includes('entries'))
  assert.ok(statsSchema.properties.by_status.required.includes('draft'))
  assert.deepEqual(Object.keys(statsSchema.properties.by_status.properties).sort(), ['draft', 'stale', 'verified'])
  assert.deepEqual(Object.keys(statsSchema.properties.dispatch.properties).sort(), [
    'by_role', 'count', 'fallback_rate', 'p50_ms', 'p95_ms',
  ])
  assert.deepEqual(statsSchema.properties.dispatch.properties.p50_ms.oneOf.map((branch) => branch.type), ['number', 'null'])
  assert.ok(byName.get('memory_write').parameters.required.includes('kind'))
  assert.deepEqual(byName.get('memory_write').parameters.properties.status.enum, ['draft'])
  assert.ok(byName.get('memory_verify').parameters.required.includes('verified_by'))
  assert.equal(typeof byName.get('memory_stats').execute, 'function')
})

test('memory_search execute: namespace хода, сниппет ≤ 300', async (t) => {
  const { memory, byName, exec, dir } = setup(t)
  const long = 'память проекта '.repeat(40)
  memory.storeFor(dir).insertEntry({
    kind: 'fact',
    title: 'Память проекта',
    text: long,
    status: 'verified',
    confidence: 1,
    sourcePath: 'docs/memory.md',
  })
  const results = await byName.get('memory_search').execute({ query: 'память проекта' }, exec)
  assert.ok(results.length > 0)
  assert.ok(results[0].snippet.length <= 300)
  assert.equal(results[0].status, 'verified')
  assert.equal(typeof results[0].id, 'number')
})

test('memory_write: draft, потолок 0.6 для модели, источник; search видит только с all', async (t) => {
  const { memory, byName, exec, dir } = setup(t)
  const written = await byName.get('memory_write').execute({
    title: 'Новое знание',
    text: 'уникальное знание инструмента',
    kind: 'fact',
    sources: [{ path: 'docs/new.md' }],
    confidence: 1,
  }, exec)
  assert.equal(written.status, 'draft')
  const entry = memory.storeFor(dir).getEntry(written.id)
  assert.equal(entry.author, 'model:memory_write')
  assert.ok(entry.confidence <= 0.6)
  const hidden = await byName.get('memory_search').execute({ query: 'уникальное знание инструмента' }, exec)
  assert.equal(hidden.length, 0, 'по умолчанию только verified')
  const all = await byName.get('memory_search').execute({ query: 'уникальное знание инструмента', status: 'all' }, exec)
  assert.ok(all.some((item) => item.id === written.id))
})

test('memory_verify и memory_invalidate execute', async (t) => {
  const { byName, exec } = setup(t)
  const written = await byName.get('memory_write').execute({
    title: 'Для проверки',
    text: 'текст для verify',
    kind: 'fact',
    sources: [{ path: 'docs/verify.md' }],
  }, exec)
  const verified = await byName.get('memory_verify').execute({ id: written.id, verified_by: 'reviewer' }, exec)
  assert.deepEqual(verified, { id: written.id, status: 'verified' })

  const affected = await byName.get('memory_invalidate').execute({ path: 'docs/verify.md' }, exec)
  assert.equal(affected.affected, 1)
})

test('memory_stats и ошибки инструментов: ошибка не ломает регистрацию', async (t) => {
  const { byName, exec } = setup(t)
  const stats = await byName.get('memory_stats').execute({}, exec)
  assert.equal(typeof stats.entries, 'number')
  assert.ok(Object.hasOwn(stats, 'dispatch'))

  await assert.rejects(
    () => byName.get('memory_write').execute({ title: '', text: 'x', kind: 'fact' }, exec),
    /title/,
  )
  await assert.rejects(
    () => byName.get('memory_write').execute({ title: 'x', text: 'x', kind: 'bogus' }, exec),
    /kind/,
  )
  await assert.rejects(
    () => byName.get('memory_verify').execute({ id: 999, verified_by: 'session-1' }, exec),
    /verified_by/,
  )
  assert.equal(byName.size, 5)
})

test('без сервиса tools плагин грузится и не регистрирует инструменты', (t) => {
  const { registered, memory } = setup(t, { withTools: false })
  assert.equal(registered.length, 0)
  assert.ok(memory)
})

test('fallback: raw-схемы проходят контракт ToolDefinition и аргументы валидируются', async (t) => {
  const { registered, byName, exec, memory, dir } = setup(t)
  for (const definition of registered) {
    assertRawToolSchema(definition.parameters, `${definition.name}.parameters`)
    assertRawToolSchema(definition.output.schema, `${definition.name}.output.schema`)
    assert.equal(typeof definition.execute, 'function')
  }

  // Fallback не полагается на валидатор DSH: execute сам проверяет аргументы.
  await assert.rejects(() => byName.get('memory_search').execute({}, exec), /invalid arguments: query/)
  await assert.rejects(() => byName.get('memory_search').execute({ query: 'x', k: '1' }, exec), /k must be a number/)
  await assert.rejects(() => byName.get('memory_search').execute({ query: 'x', status: 'stale' }, exec), /status must be one of/)

  // Реальные выходы проходят output-схему (не только объявлены).
  memory.storeFor(dir).insertEntry({
    kind: 'fact', title: 'Схема', text: 'выход проходит схему', status: 'verified', confidence: 1, sourcePath: 'docs/schema.md',
  })
  const searchOutput = await byName.get('memory_search').execute({ query: 'схема' }, exec)
  assert.deepEqual(validateRawValue(byName.get('memory_search').output.schema, searchOutput, ''), [])
  const statsOutput = await byName.get('memory_stats').execute({}, exec)
  assert.deepEqual(validateRawValue(byName.get('memory_stats').output.schema, statsOutput, ''), [])
})

/** Портируемый контракт raw ToolDefinition: без author-only required:true. */
function assertRawToolSchema(schema, path) {
  assert.ok(schema !== null && typeof schema === 'object' && !Array.isArray(schema), `${path}: схема должна быть объектом`)
  assert.ok(!Object.hasOwn(schema, 'required') || Array.isArray(schema.required), `${path}: required должен быть массивом`)
  if (Object.hasOwn(schema, 'oneOf')) {
    assert.ok(Array.isArray(schema.oneOf) && schema.oneOf.length >= 2, `${path}: oneOf должен быть массивом`)
    schema.oneOf.forEach((branch, index) => assertRawToolSchema(branch, `${path}.oneOf[${index}]`))
  }
  if (schema.type === 'object') {
    if (Object.hasOwn(schema, 'additionalProperties')) {
      assert.equal(typeof schema.additionalProperties, 'boolean', `${path}: additionalProperties должен быть boolean`)
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      assertRawToolSchema(child, `${path}.properties.${key}`)
      assert.ok(typeof child.required !== 'boolean', `${path}.properties.${key}: author-only required не допускается`)
    }
  }
  if (schema.type === 'array') {
    assert.ok(schema.items !== undefined, `${path}: items обязателен`)
    assertRawToolSchema(schema.items, `${path}.items`)
  }
  if (schema.type !== undefined) {
    assert.ok(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type), `${path}: неизвестный type ${schema.type}`)
  }
}

/** Минимальная проверка значения по raw-схеме для теста. */
function validateRawValue(schema, value, path) {
  const violations = []
  if (schema.oneOf !== undefined) {
    if (schema.oneOf.every((branch) => validateRawValue(branch, value, path).length > 0)) violations.push(`${path}: oneOf`)
    return violations
  }
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) violations.push(`${path}: object`)
    else {
      for (const key of schema.required ?? []) if (value[key] === undefined) violations.push(`${path}.${key}: required`)
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (value[key] !== undefined) violations.push(...validateRawValue(child, value[key], `${path}.${key}`))
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) violations.push(`${path}: array`)
    else value.forEach((item, index) => violations.push(...validateRawValue(schema.items, item, `${path}[${index}]`)))
  } else if (schema.type === 'string' && typeof value !== 'string') violations.push(`${path}: string`)
  else if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) violations.push(`${path}: number`)
  else if (schema.type === 'integer' && !Number.isInteger(value)) violations.push(`${path}: integer`)
  else if (schema.type === 'boolean' && typeof value !== 'boolean') violations.push(`${path}: boolean`)
  else if (schema.type === 'null' && value !== null) violations.push(`${path}: null`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) violations.push(`${path}: enum`)
  return violations
}

test('tools появляется после apply: ctx.inject дожидается сервиса и регистрирует один раз', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-tools-late-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const registered = []
  const callbacks = []
  let memory
  const ctx = {
    on: () => {},
    effect: () => {},
    provide: (name, service) => { if (name === 'memory') memory = service },
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
    inject: (services, callback) => {
      assert.deepEqual(services, ['tools'])
      callbacks.push(callback)
      return () => {}
    },
  }
  plugin.apply(ctx, { db_path: dir, namespace: 'demo' })
  // apply без tools не падает и ничего не регистрирует.
  assert.equal(registered.length, 0)
  assert.ok(memory)

  const tools = {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  }
  // Сервис tools появляется позже; callback получает контекст с tools.
  callbacks[0]({ tools })
  assert.equal(registered.length, 5)
  assert.deepEqual(registered.map((definition) => definition.name).sort(), [
    'memory_invalidate', 'memory_search', 'memory_stats', 'memory_verify', 'memory_write',
  ])
  // Повторный callback (пересоздание сервиса) не дублирует регистрацию.
  callbacks[0]({ tools })
  assert.equal(registered.length, 5)
})

test('без tools и без inject apply не падает', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-tools-none-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = {
    on: () => {},
    effect: () => {},
    provide: () => {},
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
  }
  assert.doesNotThrow(() => plugin.apply(ctx, { db_path: dir, namespace: 'demo' }))
})

test('повторный apply на том же контексте не дублирует memory.*', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-tools-twice-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const registered = []
  const ctx = {
    tools: { register(definition) { registered.push(definition); return () => {} } },
    on: () => {},
    effect: () => {},
    provide: () => {},
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
  }
  plugin.apply(ctx, { db_path: dir, namespace: 'demo' })
  plugin.apply(ctx, { db_path: dir, namespace: 'demo' })
  assert.equal(registered.length, 5)
})

test('cleanup/reload на том же ctx снова регистрирует memory.*; поздний callback после dispose — нет', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-tools-reload-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const active = new Set()
  const cleanups = []
  const ctx = {
    tools: {
      register(definition) {
        active.add(definition.name)
        return () => active.delete(definition.name)
      },
    },
    on: () => {},
    effect: (callback) => { cleanups.push(callback); return () => {} },
    provide: () => {},
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
  }
  plugin.apply(ctx, { db_path: dir, namespace: 'demo' })
  assert.equal(active.size, 5)
  for (const cleanup of cleanups.splice(0)) {
    const dispose = cleanup()
    if (typeof dispose === 'function') dispose()
  }
  assert.equal(active.size, 0)
  plugin.apply(ctx, { db_path: dir, namespace: 'demo' })
  assert.equal(active.size, 5, 'после cleanup/reload инструменты должны вернуться')

  // Поздний ctx.inject callback после выгрузки не должен регистрировать.
  const lateCallbacks = []
  const lateCtx = {
    on: () => {},
    effect: (callback) => { cleanups.push(callback); return () => {} },
    provide: () => {},
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
    inject: (_services, callback) => { lateCallbacks.push(callback); return () => {} },
  }
  plugin.apply(lateCtx, { db_path: dir, namespace: 'demo' })
  for (const cleanup of cleanups.splice(0)) {
    const dispose = cleanup()
    if (typeof dispose === 'function') dispose()
  }
  lateCallbacks[0]({ tools: { register: (definition) => { active.add(definition.name); return () => active.delete(definition.name) } } })
  assert.equal(active.size, 0, 'callback после dispose не должен регистрировать')
})
