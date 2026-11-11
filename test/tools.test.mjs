/**
 * Тесты регистрации `memory.*` в `ctx.tools` (задача 031): схемы, execute,
 * namespace хода, ошибки инструмента и опциональность без сервиса tools.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
    'memory.invalidate',
    'memory.search',
    'memory.stats',
    'memory.verify',
    'memory.write',
  ])
  const search = byName.get('memory.search')
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
  const statsSchema = byName.get('memory.stats').output.schema
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
  assert.ok(byName.get('memory.write').parameters.required.includes('kind'))
  assert.deepEqual(byName.get('memory.write').parameters.properties.status.enum, ['draft'])
  assert.ok(byName.get('memory.verify').parameters.required.includes('verified_by'))
  assert.equal(typeof byName.get('memory.stats').execute, 'function')
})

test('memory.search execute: namespace хода, сниппет ≤ 300', async (t) => {
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
  const results = await byName.get('memory.search').execute({ query: 'память проекта' }, exec)
  assert.ok(results.length > 0)
  assert.ok(results[0].snippet.length <= 300)
  assert.equal(results[0].status, 'verified')
  assert.equal(typeof results[0].id, 'number')
})

test('memory.write: draft, потолок 0.6 для модели, источник; search видит только с all', async (t) => {
  const { memory, byName, exec, dir } = setup(t)
  const written = await byName.get('memory.write').execute({
    title: 'Новое знание',
    text: 'уникальное знание инструмента',
    kind: 'fact',
    sources: [{ path: 'docs/new.md' }],
    confidence: 1,
  }, exec)
  assert.equal(written.status, 'draft')
  const entry = memory.storeFor(dir).getEntry(written.id)
  assert.equal(entry.author, 'model:memory.write')
  assert.ok(entry.confidence <= 0.6)
  const hidden = await byName.get('memory.search').execute({ query: 'уникальное знание инструмента' }, exec)
  assert.equal(hidden.length, 0, 'по умолчанию только verified')
  const all = await byName.get('memory.search').execute({ query: 'уникальное знание инструмента', status: 'all' }, exec)
  assert.ok(all.some((item) => item.id === written.id))
})

test('memory.verify и memory.invalidate execute', async (t) => {
  const { byName, exec } = setup(t)
  const written = await byName.get('memory.write').execute({
    title: 'Для проверки',
    text: 'текст для verify',
    kind: 'fact',
    sources: [{ path: 'docs/verify.md' }],
  }, exec)
  const verified = await byName.get('memory.verify').execute({ id: written.id, verified_by: 'reviewer' }, exec)
  assert.deepEqual(verified, { id: written.id, status: 'verified' })

  const affected = await byName.get('memory.invalidate').execute({ path: 'docs/verify.md' }, exec)
  assert.equal(affected.affected, 1)
})

test('memory.stats и ошибки инструментов: ошибка не ломает регистрацию', async (t) => {
  const { byName, exec } = setup(t)
  const stats = await byName.get('memory.stats').execute({}, exec)
  assert.equal(typeof stats.entries, 'number')
  assert.ok(Object.hasOwn(stats, 'dispatch'))

  await assert.rejects(
    () => byName.get('memory.write').execute({ title: '', text: 'x', kind: 'fact' }, exec),
    /title/,
  )
  await assert.rejects(
    () => byName.get('memory.write').execute({ title: 'x', text: 'x', kind: 'bogus' }, exec),
    /kind/,
  )
  await assert.rejects(
    () => byName.get('memory.verify').execute({ id: 999, verified_by: 'session-1' }, exec),
    /verified_by/,
  )
  assert.equal(byName.size, 5)
})

test('без сервиса tools плагин грузится и не регистрирует инструменты', (t) => {
  const { registered, memory } = setup(t, { withTools: false })
  assert.equal(registered.length, 0)
  assert.ok(memory)
})

test('fallback: raw-схемы проходят реальный assertSupportedJsonSchema и аргументы валидируются', async (t) => {
  const harness = '/Users/victor/projects/deepseek-harness/packages/core/tools/lib/index.js'
  if (!existsSync(harness)) {
    t.skip('DeepSeek Harness checkout недоступен')
    return
  }
  const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(harness).href)
  const { registered, byName, exec, memory, dir } = setup(t)
  for (const definition of registered) {
    assert.doesNotThrow(() => assertSupportedJsonSchema(definition.parameters), definition.name)
    assert.doesNotThrow(() => assertSupportedJsonSchema(definition.output.schema), definition.name)
  }

  // Fallback не полагается на валидатор DSH: execute сам проверяет аргументы.
  await assert.rejects(() => byName.get('memory.search').execute({}, exec), /invalid arguments: query/)
  await assert.rejects(() => byName.get('memory.search').execute({ query: 'x', k: '1' }, exec), /k must be a number/)
  await assert.rejects(() => byName.get('memory.search').execute({ query: 'x', status: 'stale' }, exec), /status must be one of/)

  // Реальные выходы проходят output-схему (не только объявлены).
  memory.storeFor(dir).insertEntry({
    kind: 'fact', title: 'Схема', text: 'выход проходит схему', status: 'verified', confidence: 1, sourcePath: 'docs/schema.md',
  })
  const searchOutput = await byName.get('memory.search').execute({ query: 'схема' }, exec)
  assert.deepEqual(validateJsonSchemaValue(byName.get('memory.search').output.schema, searchOutput, ''), [])
  const statsOutput = await byName.get('memory.stats').execute({}, exec)
  assert.deepEqual(validateJsonSchemaValue(byName.get('memory.stats').output.schema, statsOutput, ''), [])
})
