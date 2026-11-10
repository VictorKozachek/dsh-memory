/**
 * Тесты опционального пакета эмбеддингов (задача 016): миграция 4/BLOB,
 * локальный провайдер, бэкфилл, гибридный канал, конфиг/ошибки, OpenAI-
 * совместимый и Ollama провайдеры на моках, NO_NETWORK, doctor и откат на FTS5.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildMemoryBlock } from '../lib/inject.js'
import { searchMemory } from '../lib/search.js'
import { openStore } from '../lib/store.js'
import { backfillEmbeddings } from '../packages/dsh-memory-embeddings/lib/backfill.js'
import { cosineSimilarity, createLocalChannel } from '../packages/dsh-memory-embeddings/lib/channel.js'
import { resolveConfig } from '../packages/dsh-memory-embeddings/lib/config.js'
import { doctorReport } from '../packages/dsh-memory-embeddings/lib/doctor.js'
import { apply, createProvider } from '../packages/dsh-memory-embeddings/lib/index.js'
import { createLocalProvider, embedLocal } from '../packages/dsh-memory-embeddings/lib/providers/local.js'
import { createOllamaProvider } from '../packages/dsh-memory-embeddings/lib/providers/ollama.js'
import { createOpenAiProvider } from '../packages/dsh-memory-embeddings/lib/providers/openai.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Открыть хранилище на временном каталоге. */
function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-embeddings-'))
  const store = openStore({ dbPath: dir, namespace: 'demo' })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

/** Запись, которую должен находить поиск. */
function add(store, title, text) {
  return store.insertEntry({ kind: 'doc', title, text, status: 'verified', confidence: 1 })
}

test('миграция 4: таблица embeddings, BLOB-вектор читается обратно', (t) => {
  const store = tempStore(t)
  const tables = store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
  assert.ok(tables.includes('embeddings'))

  const { id } = add(store, 'Индексатор', 'Индексатор обходит файлы')
  const written = store.upsertEmbedding({ entryId: id, model: 'm1', vector: [0.1, 0.2, 0.3] })
  assert.deepEqual(written, { entryId: id, model: 'm1', dim: 3 })
  const read = store.getEmbedding(id, 'm1')
  assert.equal(read.dim, 3)
  assert.deepEqual([...read.vector].map((value) => Number(value.toFixed(3))), [0.1, 0.2, 0.3])
  assert.equal(store.listEmbeddings('m1').length, 1)
  assert.equal(store.listEntriesWithoutEmbedding('m1').length, 0)
  assert.equal(store.deleteEmbedding(id, 'm1'), true)
  assert.equal(store.getEmbedding(id, 'm1'), null)
})

test('локальный провайдер: детерминированный нормализованный вектор без сети', () => {
  const first = embedLocal('память проекта')
  const second = embedLocal('память проекта')
  const other = embedLocal('совершенно другой текст')
  assert.deepEqual([...first], [...second])
  assert.ok(Math.abs(Math.hypot(...first) - 1) < 1e-5)
  assert.ok(cosineSimilarity(first, second) > 0.99)
  assert.ok(cosineSimilarity(first, other) < cosineSimilarity(first, second))

  const provider = createLocalProvider({ dim: 64 })
  assert.equal(provider.kind, 'local')
  assert.equal(provider.embed(['a', 'b']).vectors.length, 2)
  assert.equal(provider.embedOne('a').length, 64)
})

test('бэкфилл и канал: brute-force косинус находит запись; гибрид не хуже FTS5', async (t) => {
  const store = tempStore(t)
  const id = add(store, 'Индексатор', 'Индексатор обходит markdown-файлы воркспейса').id
  const provider = createLocalProvider()

  const summary = await backfillEmbeddings({ store, provider, model: provider.model })
  assert.equal(summary.embedded, 1)
  assert.equal(summary.failed, 0)
  assert.equal(store.listEmbeddings(provider.model).length, 1)

  const channel = createLocalChannel({ store, provider, model: provider.model, weight: 0.5 })
  // Канал умеет лениво досчитать векторы для нового/другого воркспейса.
  assert.ok(channel.search({ query: 'индексатор', limit: 5 }).some((hit) => hit.id === id))
  const hits = channel.search({ query: 'индексатор', limit: 5 })
  assert.ok(hits.some((hit) => hit.id === id))

  const fts = searchMemory(store, { query: 'индексатор' })
  const hybrid = searchMemory(store, { query: 'индексатор' }, { channels: [channel] })
  assert.ok(hybrid.some((row) => row.id === id))
  assert.deepEqual(searchMemory(store, { query: 'индексатор' }, { channels: [] }), fts, 'без каналов поведение не меняется')

  const block = buildMemoryBlock(store, 'индексатор', { env: {}, channels: [channel] })
  assert.ok(block.block !== null)
})

test('конфиг: дефолт выключен; enabled без provider/model/base_url — предупреждения и FTS5', () => {
  assert.deepEqual(resolveConfig({}).config, {
    enabled: false,
    provider: '',
    base_url: '',
    model: '',
    api_key_env: 'DSH_MEMORY_EMBEDDINGS_API_KEY',
    batch_size: 32,
    timeout_ms: 5_000,
    max_retries: 2,
    hybrid_weight: 0.5,
  })
  const broken = resolveConfig({ enabled: true })
  assert.equal(broken.config.enabled, true)
  assert.ok(broken.warnings.some((warning) => warning.includes('provider пуст')))
  assert.ok(broken.warnings.some((warning) => warning.includes('model пуст')))
  const noBase = resolveConfig({ enabled: true, provider: 'openai-compatible', model: 'm' })
  assert.ok(noBase.warnings.some((warning) => warning.includes('base_url пуст')))
  assert.throws(() => createProvider(noBase.config), /base_url не задан/)
})

test('apply: disabled ничего не регистрирует; local регистрирует канал', (t) => {
  const store = tempStore(t)
  const channels = []
  const logs = []
  const memory = {
    storeFor: () => store,
    registerSearchChannel: (channel) => {
      channels.push(channel)
      return () => {}
    },
  }
  const ctx = { memory, logger: { debug: (message) => logs.push(message), info: (message) => logs.push(message), warn: (message) => logs.push(message) } }

  apply(ctx, { enabled: false })
  assert.equal(channels.length, 0)
  assert.ok(logs.some((line) => line.includes('выключены')))

  apply(ctx, { enabled: true, provider: 'local', model: 'local-hash-128' })
  assert.equal(channels.length, 1)
  assert.equal(channels[0].name, 'embeddings')
  assert.ok(logs.some((line) => line.includes('локальные эмбеддинги')))
})

test('apply: нет ключа API — предупреждение и без канала (FTS5)', (t) => {
  const store = tempStore(t)
  const channels = []
  const logs = []
  const ctx = {
    memory: { storeFor: () => store, registerSearchChannel: (channel) => channels.push(channel) },
    logger: { debug: () => {}, info: () => {}, warn: (message) => logs.push(message) },
  }
  const env = { DSH_MEMORY_EMBEDDINGS_API_KEY: '' }
  // apply читает process.env; без ключа в process.env провайдер падает.
  apply(ctx, { enabled: true, provider: 'openai-compatible', base_url: 'https://example.test/v1', model: 'm', api_key_env: 'DSH_MEMORY_EMBEDDINGS_API_KEY_TEST_MISSING' })
  assert.equal(channels.length, 0)
  assert.ok(logs.some((line) => line.includes('ключ не задан')), logs.join('\\n'))
})

test('OpenAI-совместимый провайдер: ключ из env, батч, redaction, NO_NETWORK', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [1, 0, 0] }, { embedding: [0, 1, 0] }] }),
      text: async () => '',
    }
  }
  const env = { DSH_MEMORY_EMBEDDINGS_API_KEY: 'secret-key-123' }
  const provider = createOpenAiProvider({
    base_url: 'https://api.test/v1/',
    model: 'text-embedding-test',
    api_key_env: 'DSH_MEMORY_EMBEDDINGS_API_KEY',
    env,
    fetchImpl,
    batch_size: 2,
  })
  const result = await provider.embed(['первый', 'второй'])
  assert.equal(result.vectors.length, 2)
  assert.equal(result.dim, 3)
  assert.equal(calls[0].url, 'https://api.test/v1/embeddings')
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret-key-123')
  assert.deepEqual(JSON.parse(calls[0].init.body).input, ['первый', 'второй'])

  // NO_NETWORK запрещает egress до запроса.
  const blockedCalls = []
  const blocked = createOpenAiProvider({
    base_url: 'https://api.test/v1',
    model: 'm',
    api_key_env: 'DSH_MEMORY_EMBEDDINGS_API_KEY',
    env: { ...env, DSH_MEMORY_NO_NETWORK: '1' },
    fetchImpl: (...args) => { blockedCalls.push(args); return fetchImpl(...args) },
  })
  await assert.rejects(() => blocked.embed(['x']), /сеть запрещена/)
  assert.equal(blockedCalls.length, 0)

  // Ошибка провайдера с ключом в теле не должна светить ключ.
  const failing = createOpenAiProvider({
    base_url: 'https://api.test/v1',
    model: 'm',
    api_key_env: 'DSH_MEMORY_EMBEDDINGS_API_KEY',
    env,
    fetchImpl: async () => ({ ok: false, status: 400, text: async () => 'bad secret-key-123' }),
  })
  await assert.rejects(() => failing.embed(['x']), (error) => {
    assert.doesNotMatch(error.message, /secret-key-123/)
    assert.match(error.message, /\*\*\*/)
    return true
  })

  assert.throws(() => createOpenAiProvider({ base_url: 'https://api.test/v1', model: 'm', env: {} }), /ключ не задан в env/)
  assert.throws(() => createOpenAiProvider({ base_url: '', model: 'm', env }), /base_url обязателен/)
})

test('Ollama провайдер: локальный HTTP на моке и NO_NETWORK', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ embedding: [0.5, 0.5] }) }
  }
  const provider = createOllamaProvider({ model: 'nomic-embed-text', env: {}, fetchImpl })
  const result = await provider.embed(['текст'])
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/embeddings')
  assert.deepEqual([...result.vectors[0]], [0.5, 0.5])

  const blocked = createOllamaProvider({ model: 'nomic-embed-text', env: { DSH_MEMORY_NO_NETWORK: '1' }, fetchImpl })
  await assert.rejects(() => blocked.embed(['текст']), /сеть запрещена/)
})

test('doctor предупреждает об отправке текста для сетевого провайдера и молчит для local', () => {
  const local = doctorReport(resolveConfig({ enabled: true, provider: 'local', model: 'm' }).config, { provider: { kind: 'local', model: 'm' } })
  assert.ok(local.every((line) => line.level === 'info'))

  const api = doctorReport(resolveConfig({ enabled: true, provider: 'openai-compatible', model: 'm' }).config, {
    provider: { kind: 'openai-compatible', model: 'm' },
  })
  assert.ok(api.some((line) => line.level === 'warn' && line.message.includes('ВНИМАНИЕ')))
  assert.ok(api.some((line) => line.message.includes('api_key_env') || line.message.includes('env')))
  assert.ok(!api.some((line) => line.message.includes('secret')))
})

test('отчёт эмбеддингов: качество и латентность против FTS5, дефолт выключен', () => {
  const report = readFileSync(join(ROOT, 'docs/benchmark-embeddings.md'), 'utf8')
  for (const needle of ['FTS5', 'локальные векторы', 'hit-rate', 'Латентность, p95', 'дефолт — FTS5', 'scripts/embeddings-benchmark.mjs']) {
    assert.ok(report.includes(needle), `в отчёте нет «${needle}»`)
  }
})

test('локальный канал лениво досчитывает векторы для нового хранилища', (t) => {
  const store = tempStore(t)
  const id = add(store, 'Хранилище', 'Хранилище проекта живёт в SQLite').id
  const provider = createLocalProvider()
  assert.equal(store.listEmbeddings(provider.model).length, 0)
  const channel = createLocalChannel({ store, provider, model: provider.model })
  assert.ok(channel.search({ query: 'хранилище' }).some((hit) => hit.id === id))
  assert.ok(store.listEmbeddings(provider.model).length >= 1)
})
