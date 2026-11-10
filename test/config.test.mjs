/**
 * Тесты конфигурации: дефолты из README, слияние с конфигом ряда, переменные
 * окружения `DSH_MEMORY_*`, правило `namespace: auto` и устойчивость к
 * невалидным значениям.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { basename } from 'node:path'
import test from 'node:test'

import { DEFAULT_CONFIG, resolveConfig, resolveNamespace } from '../lib/config.js'
import { apply } from '../lib/index.js'

const ENV_KEYS = ['DSH_MEMORY_DB', 'DSH_MEMORY_INJECT', 'DSH_MEMORY_TOP_K']

/** Мок cordis-контекста с записью сервисов и предупреждений. */
function mockContext() {
  const services = new Map()
  const warnings = []
  return {
    services,
    warnings,
    provide(service, value) {
      services.set(service, value)
      return () => services.delete(service)
    },
    logger: {
      debug() {},
      info() {},
      warn: (message) => warnings.push(message),
    },
  }
}

/** Убрать `DSH_MEMORY_*` из process.env на время теста и вернуть обратно. */
function isolateEnv(t) {
  const saved = new Map()
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test('дефолты повторяют блок dsh-memory из README', () => {
  const { config, warnings } = resolveConfig({}, { env: {} })

  assert.deepEqual(config, DEFAULT_CONFIG)
  assert.deepEqual(warnings, [])
  assert.equal(config.namespace, 'auto')
  assert.equal(config.db_path, '~/.dsh/memory')
  assert.deepEqual(config.inject, { enabled: true, top_k: 3, token_budget: 600 })
  assert.deepEqual(config.search, { default_status: 'verified', snippet_chars: 300, synonyms: true })
  assert.deepEqual(config.index, {
    include: ['**/*.md'],
    exclude: ['.git/**', 'node_modules/**', 'target/**', 'dist/**', 'tmp/**', '.cache/**'],
    max_chunk_tokens: 800,
  })
  assert.deepEqual(config.embeddings, { enabled: false, model: '' })
  assert.deepEqual(config.verify, { require_source_for_verified: true })
  assert.deepEqual(config.cascade, {
    enabled: false,
    preset: 'triage',
    model: '',
    max_tokens: 300,
    write_back: true,
  })
})

test('отсутствующий конфиг — это дефолты без предупреждений', () => {
  for (const raw of [undefined, null]) {
    const { config, warnings } = resolveConfig(raw, { env: {} })
    assert.deepEqual(config, DEFAULT_CONFIG)
    assert.deepEqual(warnings, [])
  }
})

test('конфиг ряда накладывается поверх дефолтов послойно', () => {
  const { config, warnings } = resolveConfig({
    namespace: 'project-x',
    db_path: '/tmp/memory',
    inject: { top_k: 5 },
    search: { snippet_chars: 120 },
    index: { include: ['docs/**/*.md', 'README.md'] },
    embeddings: { enabled: true, model: 'text-embedding-3-small' },
    verify: { require_source_for_verified: false },
    cascade: { enabled: true, model: 'cheap-model', max_tokens: 200 },
  }, { env: {} })

  assert.deepEqual(warnings, [])
  assert.equal(config.namespace, 'project-x')
  assert.equal(config.db_path, '/tmp/memory')
  // Поля секции, которых нет в конфиге ряда, остаются дефолтными.
  assert.equal(config.inject.top_k, 5)
  assert.equal(config.inject.enabled, true)
  assert.equal(config.inject.token_budget, 600)
  assert.equal(config.search.snippet_chars, 120)
  assert.equal(config.search.default_status, 'verified')
  assert.deepEqual(config.index.include, ['docs/**/*.md', 'README.md'])
  assert.deepEqual(config.index.exclude, DEFAULT_CONFIG.index.exclude)
  assert.equal(config.index.max_chunk_tokens, 800)
  assert.deepEqual(config.embeddings, { enabled: true, model: 'text-embedding-3-small' })
  assert.equal(config.verify.require_source_for_verified, false)
  assert.deepEqual(config.cascade, {
    enabled: true,
    preset: 'triage',
    model: 'cheap-model',
    max_tokens: 200,
    write_back: true,
  })
})

test('невалидный конфиг не роняет разбор: дефолты и предупреждения', () => {
  for (const raw of ['строка', 42, ['массив']]) {
    const { config, warnings } = resolveConfig(raw, { env: {} })
    assert.deepEqual(config, DEFAULT_CONFIG)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /конфиг: ожидался объект/)
  }
})

test('каждое невалидное поле заменяется дефолтом с предупреждением', () => {
  const { config, warnings } = resolveConfig({
    namespace: 7,
    db_path: '',
    inject: { enabled: 'yes', top_k: 0, token_budget: 1.5 },
    search: { default_status: 'stale', snippet_chars: -1, synonyms: 'yes' },
    index: { include: 'README.md', exclude: [1], max_chunk_tokens: '800' },
    embeddings: 'off',
    verify: { require_source_for_verified: 'no' },
    cascade: { enabled: 'yes', preset: 7, model: 42, max_tokens: 0, write_back: 'no' },
  }, { env: {} })

  assert.deepEqual(config, DEFAULT_CONFIG)
  for (const field of [
    'namespace',
    'db_path',
    'inject.enabled',
    'inject.top_k',
    'inject.token_budget',
    'search.default_status',
    'search.snippet_chars',
    'search.synonyms',
    'index.include',
    'index.exclude',
    'index.max_chunk_tokens',
    'embeddings',
    'verify.require_source_for_verified',
    'cascade.enabled',
    'cascade.preset',
    'cascade.model',
    'cascade.max_tokens',
    'cascade.write_back',
  ]) {
    assert.ok(warnings.some((warning) => warning.includes(field)), `нет предупреждения про ${field}: ${JSON.stringify(warnings)}`)
  }
})

test('DSH_MEMORY_* перекрывают конфиг', () => {
  const { config, warnings } = resolveConfig(
    { db_path: '/from/config', inject: { enabled: true, top_k: 2 } },
    { env: { DSH_MEMORY_DB: '/from/env', DSH_MEMORY_INJECT: 'off', DSH_MEMORY_TOP_K: '7' } },
  )

  assert.deepEqual(warnings, [])
  assert.equal(config.db_path, '/from/env')
  assert.equal(config.inject.enabled, false)
  assert.equal(config.inject.top_k, 7)

  for (const value of ['off', 'false', '0', 'no', 'OFF']) {
    assert.equal(resolveConfig({}, { env: { DSH_MEMORY_INJECT: value } }).config.inject.enabled, false)
  }
  for (const value of ['on', 'true', '1', 'yes', 'ON']) {
    assert.equal(resolveConfig({}, { env: { DSH_MEMORY_INJECT: value } }).config.inject.enabled, true)
  }
})

test('невалидное или пустое DSH_MEMORY_* не ломает конфиг', () => {
  const { config, warnings } = resolveConfig(
    { inject: { top_k: 4 } },
    { env: { DSH_MEMORY_INJECT: 'maybe', DSH_MEMORY_TOP_K: '-3' } },
  )
  assert.equal(config.inject.enabled, true)
  assert.equal(config.inject.top_k, 4)
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /DSH_MEMORY_INJECT/)
  assert.match(warnings[1], /DSH_MEMORY_TOP_K/)

  // Пустое значение — это «переменная не задана», без предупреждений.
  const empty = resolveConfig({}, { env: { DSH_MEMORY_DB: '', DSH_MEMORY_INJECT: '  ', DSH_MEMORY_TOP_K: '' } })
  assert.deepEqual(empty.config, DEFAULT_CONFIG)
  assert.deepEqual(empty.warnings, [])
})

test('namespace: auto = имя каталога воркспейса', () => {
  const { config, warnings } = resolveConfig({ namespace: 'auto' }, { env: {}, workspace: '/Users/victor/projects/dsh-memory/' })
  assert.equal(config.namespace, 'dsh-memory')
  assert.deepEqual(warnings, [])

  assert.equal(resolveNamespace('auto', '/w/project'), 'project')
  assert.equal(resolveNamespace('AUTO', '/w/project'), 'project')
  assert.equal(resolveNamespace('explicit', '/w/project'), 'explicit')
  // Без воркспейса auto остаётся правилом и разрешается позже.
  assert.equal(resolveNamespace('auto'), 'auto')
  assert.equal(resolveConfig({}, { env: {} }).config.namespace, 'auto')
  assert.equal(config.namespace, basename('/Users/victor/projects/dsh-memory'))
})

test('явный namespace не зависит от воркспейса', () => {
  const { config } = resolveConfig({ namespace: 'team-memory' }, { env: {}, workspace: '/w/project' })
  assert.equal(config.namespace, 'team-memory')
})

test('namespace auto, который не удаётся разрешить, остаётся auto с предупреждением', () => {
  const { config, warnings } = resolveConfig({ namespace: 'auto' }, { env: {}, workspace: '/' })
  assert.equal(config.namespace, 'auto')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /namespace/)
  assert.throws(() => resolveNamespace('auto', '/'), /имя каталога/)
})

test('конфиг заморожен и не зависит от исходного объекта', () => {
  const raw = { inject: { top_k: 4 }, index: { include: ['a.md'] } }
  const { config } = resolveConfig(raw, { env: {} })

  assert.ok(Object.isFrozen(config))
  assert.ok(Object.isFrozen(config.inject))
  assert.ok(Object.isFrozen(config.search))
  assert.ok(Object.isFrozen(config.index))
  assert.ok(Object.isFrozen(config.index.include))
  assert.ok(Object.isFrozen(config.index.exclude))
  assert.ok(Object.isFrozen(config.embeddings))
  assert.ok(Object.isFrozen(config.verify))

  raw.inject.top_k = 9
  raw.index.include.push('b.md')
  assert.equal(config.inject.top_k, 4)
  assert.deepEqual(config.index.include, ['a.md'])
})

test('apply применяет конфиг, пишет предупреждения и даёт namespaceFor', (t) => {
  isolateEnv(t)
  const ctx = mockContext()
  apply(ctx, { inject: { top_k: 0 } })

  const memory = ctx.services.get('memory')
  assert.ok(memory)
  assert.equal(memory.config.inject.top_k, 3)
  assert.equal(memory.config.namespace, 'auto')
  assert.ok(
    ctx.warnings.some((message) => message.startsWith('[dsh-memory]') && message.includes('inject.top_k')),
    `предупреждение не попало в лог: ${JSON.stringify(ctx.warnings)}`,
  )
  assert.equal(memory.namespaceFor('/Users/victor/projects/dsh-memory'), 'dsh-memory')
})

test('apply учитывает DSH_MEMORY_* и не падает на невалидном конфиге', (t) => {
  isolateEnv(t)
  process.env.DSH_MEMORY_DB = '/tmp/from-env'
  process.env.DSH_MEMORY_INJECT = 'off'
  process.env.DSH_MEMORY_TOP_K = '9'

  const ctx = mockContext()
  assert.doesNotThrow(() => apply(ctx, 'не объект'))
  const memory = ctx.services.get('memory')
  assert.equal(memory.config.db_path, '/tmp/from-env')
  assert.equal(memory.config.inject.enabled, false)
  assert.equal(memory.config.inject.top_k, 9)
  assert.ok(ctx.warnings.some((message) => message.includes('конфиг: ожидался объект')))
})
