/**
 * Тесты опционального пакета эмбеддингов (задача 016): миграция 4/BLOB,
 * локальный провайдер, бэкфилл, гибридный канал, конфиг/ошибки, OpenAI-
 * совместимый и Ollama провайдеры на моках, NO_NETWORK, doctor и откат на FTS5.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildMemoryBlock, buildMemoryBlockAsync } from '../lib/inject.js'
import { searchMemory, searchMemoryAsync } from '../lib/search.js'
import { openStore } from '../lib/store.js'
import { backfillEmbeddings } from '../packages/dsh-memory-embeddings/lib/backfill.js'
import { cosineSimilarity, createAsyncChannel, createLocalChannel } from '../packages/dsh-memory-embeddings/lib/channel.js'
import { resolveConfig } from '../packages/dsh-memory-embeddings/lib/config.js'
import { doctorReport } from '../packages/dsh-memory-embeddings/lib/doctor.js'
import { apply, createProvider } from '../packages/dsh-memory-embeddings/lib/index.js'
import { createLocalOnnxProvider } from '../packages/dsh-memory-embeddings/lib/providers/local-onnx.js'
import { doctorCommand } from '../packages/dsh-memory-embeddings/bin/doctor.js'
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

  const channel = createLocalChannel({ provider, model: provider.model, weight: 0.5 })
  // Канал умеет лениво досчитать векторы для нового/другого воркспейса.
  assert.ok(channel.search({ store, query: 'индексатор', limit: 5 }).some((hit) => hit.id === id))

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
    model_path: '',
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
  assert.equal(resolveConfig({ enabled: true, provider: 'local-onnx', model: 'm' }).config.provider, 'local-onnx')
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
  const channel = createLocalChannel({ provider, model: provider.model })
  assert.ok(channel.search({ store, query: 'хранилище' }).some((hit) => hit.id === id))
  assert.ok(store.listEmbeddings(provider.model).length >= 1)
})


test('канал не подмешивает записи из другого store/namespace с тем же id', (t) => {
  const storeA = tempStore(t)
  const dirB = mkdtempSync(join(tmpdir(), 'dsh-memory-embeddings-b-'))
  const storeB = openStore({ dbPath: dirB, namespace: 'other' })
  t.after(() => { storeB.close(); rmSync(dirB, { recursive: true, force: true }) })

  const provider = createLocalProvider()
  const idA = storeA.insertEntry({ kind: 'doc', title: 'Индексатор', text: 'Индексатор обходит файлы', status: 'verified', confidence: 1 }).id
  const idB = storeB.insertEntry({ kind: 'doc', title: 'Кот', text: 'кот сидит', status: 'verified', confidence: 1 }).id
  assert.equal(idA, idB, 'для теста нужны совпадающие id')

  // Вектор есть только в A; канал создан без замыкания store.
  storeA.upsertEmbedding({ entryId: idA, model: provider.model, vector: provider.embedOne('Индексатор обходит файлы') })
  const channel = createLocalChannel({ provider, model: provider.model })

  // В B поиска «индексатор» нет, и канал не должен вернуть запись B по id из A.
  assert.deepEqual(searchMemory(storeB, { query: 'индексатор' }), [])
  assert.deepEqual(searchMemory(storeB, { query: 'индексатор' }, { channels: [channel] }), [])
  assert.ok(searchMemory(storeA, { query: 'индексатор' }, { channels: [channel] }).some((row) => row.id === idA))
})

test('async-канал API/Ollama: гибрид работает через searchMemoryAsync и buildMemoryBlockAsync', async (t) => {
  const store = tempStore(t)
  const id = add(store, 'Индексатор', 'Индексатор обходит markdown-файлы').id
  const calls = []
  const provider = {
    kind: 'openai-compatible',
    model: 'mock-model',
    async embed(texts) {
      calls.push(...texts)
      return { vectors: texts.map((text) => (String(text).includes('индексатор') ? Float32Array.from([1, 0]) : Float32Array.from([0, 1]))), dim: 2 }
    },
  }
  const channel = createAsyncChannel({ provider, model: provider.model, batch_size: 4 })
  assert.deepEqual(searchMemory(store, { query: 'индексатор' }, { channels: [channel] }), searchMemory(store, { query: 'индексатор' }), 'sync search пропускает async-канал, не ломаясь')
  assert.ok((await searchMemoryAsync(store, { query: 'индексатор' }, { channels: [channel] })).some((row) => row.id === id))

  const block = await buildMemoryBlockAsync(store, 'индексатор', { env: {}, channels: [channel] })
  assert.ok(block.block !== null)
  assert.ok(calls.length > 0)
})

test('apply с API-провайдером регистрирует async-канал и даёт гибрид', async (t) => {
  const store = tempStore(t)
  const id = add(store, 'Индексатор', 'Индексатор обходит файлы').id
  const originalFetch = globalThis.fetch
  const originalKey = process.env.DSH_MEMORY_EMBEDDINGS_API_KEY_TEST
  process.env.DSH_MEMORY_EMBEDDINGS_API_KEY_TEST = 'secret-test'
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: body.input.map((text) => ({ embedding: String(text).includes('индексатор') ? [1, 0] : [0, 1] })) }),
      text: async () => '',
    }
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.DSH_MEMORY_EMBEDDINGS_API_KEY_TEST
    else process.env.DSH_MEMORY_EMBEDDINGS_API_KEY_TEST = originalKey
  })

  const channels = []
  const logs = []
  const ctx = {
    memory: { registerSearchChannel: (channel) => { channels.push(channel); return () => {} } },
    logger: { debug: () => {}, info: (message) => logs.push(message), warn: (message) => logs.push(message) },
  }
  apply(ctx, {
    enabled: true,
    provider: 'openai-compatible',
    base_url: 'https://api.test/v1',
    model: 'mock-model',
    api_key_env: 'DSH_MEMORY_EMBEDDINGS_API_KEY_TEST',
  })
  assert.equal(channels.length, 1)
  assert.ok(logs.some((line) => line.includes('ВНИМАНИЕ')), logs.join('\n'))

  const results = await searchMemoryAsync(store, { query: 'индексатор' }, { channels })
  assert.ok(results.some((row) => row.id === id))
})


test('local-onnx провайдер принимает локальный embedder и работает без сети', async (t) => {
  const provider = createLocalOnnxProvider({
    model: 'local-test',
    dim: 2,
    embedder: async (texts) => texts.map((text) => (String(text).includes('индексатор') ? [1, 0] : [0, 1])),
  })
  const store = tempStore(t)
  const id = add(store, 'Индексатор', 'Индексатор обходит файлы').id
  const channel = createAsyncChannel({ provider, model: provider.model })
  const results = await searchMemoryAsync(store, { query: 'индексатор' }, { channels: [channel] })
  assert.ok(results.some((row) => row.id === id))

  const unavailable = createLocalOnnxProvider({ model: 'missing-model' })
  await assert.rejects(() => unavailable.embed(['текст']), /model_path|@xenova\/transformers|канал выключен/)

  const blocked = createLocalOnnxProvider({ model: 'missing-model', model_path: '/tmp/mock-model', env: { DSH_MEMORY_NO_NETWORK: '1' } })
  await assert.rejects(() => blocked.embed(['текст']), /сеть запрещена/)
})


test('doctor-команда опционального пакета: предупреждение и наличие ключа без значения', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-doctor-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'config.json')

  const disabled = doctorCommand([], {})
  assert.equal(disabled.code, 0)
  assert.ok(disabled.lines.some((line) => line.includes('выключены')))

  writeFileSync(file, JSON.stringify({
    enabled: true,
    provider: 'openai-compatible',
    base_url: 'https://api.example.test/v1',
    model: 'text-embedding-test',
    api_key_env: 'DSH_MEMORY_DOCTOR_TEST_KEY',
  }))
  const withKey = doctorCommand(['--config', file], { DSH_MEMORY_DOCTOR_TEST_KEY: 'super-secret-value' })
  assert.equal(withKey.code, 0)
  const text = withKey.lines.join('\n')
  assert.match(text, /ВНИМАНИЕ/)
  assert.match(text, /ключ найден в env DSH_MEMORY_DOCTOR_TEST_KEY/)
  assert.ok(!text.includes('super-secret-value'), 'значение ключа не должно печататься')

  const noKey = doctorCommand(['--config', file], {})
  assert.match(noKey.lines.join('\n'), /ключа нет в env/)

  const broken = doctorCommand(['--config', join(dir, 'missing.json')], {})
  assert.equal(broken.code, 1)
  assert.match(broken.lines.join('\n'), /конфиг не прочитан/)
})

test('сервис memory.search асинхронный и использует async-канал API/Ollama', async (t) => {
  const { apply: pluginApply } = await import('../lib/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-service-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let service
  const ctx = {
    on: () => {},
    provide: (name, value) => { service = value },
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
  }
  pluginApply(ctx, { db_path: dir, namespace: 'demo' })
  const store = service.storeFor(process.cwd())
  const id = add(store, 'Индексатор', 'Индексатор обходит файлы').id

  const provider = {
    model: 'mock',
    async embed(texts) {
      return { vectors: texts.map((text) => (String(text).includes('индексатор') ? Float32Array.from([1, 0]) : Float32Array.from([0, 1]))), dim: 2 }
    },
  }
  service.registerSearchChannel(createAsyncChannel({ provider, model: provider.model }))
  const results = await service.search({ query: 'индексатор' }, { workspace: process.cwd() })
  assert.ok(results.some((row) => row.id === id))
  assert.equal(typeof service.searchSync, 'function')
})

test('local-onnx при NO_NETWORK не делает сетевых вызовов до загрузки модели', async (t) => {
  const originalFetch = globalThis.fetch
  let fetched = 0
  globalThis.fetch = async () => { fetched += 1; throw new Error('network must not be called') }
  t.after(() => { globalThis.fetch = originalFetch })
  const provider = createLocalOnnxProvider({
    model: 'missing-local-model',
    model_path: '/tmp/does-not-exist-onnx',
    env: { DSH_MEMORY_NO_NETWORK: '1' },
  })
  await assert.rejects(() => provider.embed(['текст']), /сеть запрещена/)
  assert.equal(fetched, 0)
})
