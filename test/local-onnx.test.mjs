/**
 * Тесты загрузки локальной ONNX-модели (задача 032): первый download, кэш и
 * офлайн, запрет сети/скачивания, битый артефакт, отсутствие зависимости.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createLocalOnnxProvider,
  isModelCached,
} from '../packages/dsh-memory-embeddings/lib/providers/local-onnx.js'

const MODEL = 'Xenova/test-e5'

/** Мок @xenova/transformers с прогрессом. */
function fakeTransformers({ fail = false } = {}) {
  const fake = { calls: [], env: {} }
  fake.pipeline = async (task, source, options) => {
    fake.calls.push({ task, source, options, allowRemote: fake.env.allowRemoteModels, cacheDir: fake.env.cacheDir })
    options?.progress_callback?.({ status: 'progress', progress: 42 })
    options?.progress_callback?.({ status: 'done', file: 'model.onnx' })
    if (fail) throw new Error('broken model file')
    return async (texts) => ({
      data: Float32Array.from(texts.flatMap((text) => (String(text).includes('кот') ? [1, 0] : [0, 1]))),
    })
  }
  return fake
}

/** Временный каталог. */
function tempDir(t, prefix = 'dsh-memory-onnx-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('первый запуск скачивает модель в cache_dir с прогрессом, затем кэш', async (t) => {
  const cacheDir = tempDir(t)
  const transformers = fakeTransformers()
  const logs = []
  const provider = createLocalOnnxProvider({
    model: MODEL,
    cache_dir: cacheDir,
    transformers,
    env: {},
    log: (level, message) => logs.push(`${level}:${message}`),
  })
  assert.equal(isModelCached(cacheDir, MODEL), false)
  const result = await provider.embed(['кот', 'пёс'])
  assert.equal(result.vectors.length, 2)
  assert.equal(transformers.env.allowRemoteModels, true)
  assert.equal(transformers.env.cacheDir, cacheDir)
  assert.equal(transformers.calls[0].source, MODEL)
  assert.equal(transformers.calls[0].allowRemote, true)
  assert.ok(logs.some((line) => line.includes('скачивание')))
  assert.ok(logs.some((line) => line.includes('закэширована')))
  assert.ok(logs.some((line) => line.includes('42%')))

  // Имитируем скачанный кэш и повторный запуск без сети.
  mkdirSync(join(cacheDir, 'Xenova', 'test-e5'), { recursive: true })
  writeFileSync(join(cacheDir, 'Xenova', 'test-e5', 'model.onnx'), 'weights')
  assert.equal(isModelCached(cacheDir, MODEL), true)
  const offlineTransformers = fakeTransformers()
  const offline = createLocalOnnxProvider({
    model: MODEL,
    cache_dir: cacheDir,
    allow_download: false,
    transformers: offlineTransformers,
    env: { DSH_MEMORY_NO_NETWORK: '1' },
  })
  const offlineResult = await offline.embed(['кот'])
  assert.equal(offlineResult.vectors.length, 1)
  assert.equal(offlineTransformers.env.allowRemoteModels, false)
})

test('NO_NETWORK и allow_download=false без кэша — понятная ошибка, без падения', async (t) => {
  const cacheDir = tempDir(t)
  const noNetwork = createLocalOnnxProvider({
    model: MODEL,
    cache_dir: cacheDir,
    transformers: fakeTransformers(),
    env: { DSH_MEMORY_NO_NETWORK: '1' },
  })
  await assert.rejects(() => noNetwork.embed(['кот']), /DSH_MEMORY_NO_NETWORK=1 запрещает скачивание/)

  const noDownload = createLocalOnnxProvider({
    model: MODEL,
    cache_dir: cacheDir,
    allow_download: false,
    transformers: fakeTransformers(),
    env: {},
  })
  await assert.rejects(() => noDownload.embed(['кот']), /allow_download=false/)
})

test('битый файл модели: ошибка провайдера, не падение процесса', async (t) => {
  const cacheDir = tempDir(t)
  mkdirSync(join(cacheDir, 'Xenova', 'test-e5'), { recursive: true })
  writeFileSync(join(cacheDir, 'Xenova', 'test-e5', 'model.onnx'), 'broken')
  const provider = createLocalOnnxProvider({
    model: MODEL,
    cache_dir: cacheDir,
    transformers: fakeTransformers({ fail: true }),
    env: { DSH_MEMORY_NO_NETWORK: '1' },
  })
  await assert.rejects(() => provider.embed(['кот']), /broken model file/)
})

test('нет @xenova/transformers и нет модели — ошибка про зависимость/кэш', async (t) => {
  const cacheDir = tempDir(t)
  const provider = createLocalOnnxProvider({
    model: 'Xenova/absent-model',
    cache_dir: cacheDir,
    allow_download: false,
    env: {},
  })
  await assert.rejects(() => provider.embed(['кот']), /не найдена.*allow_download|@xenova\/transformers/)
})

test('createProvider заранее откатывается на FTS5, если модели нет и скачивание запрещено', async (t) => {
  const { createProvider } = await import('../packages/dsh-memory-embeddings/lib/index.js')
  const { resolveConfig } = await import('../packages/dsh-memory-embeddings/lib/config.js')
  const cacheDir = tempDir(t)
  const base = resolveConfig({ enabled: true, provider: 'local-onnx', model: MODEL, cache_dir: cacheDir }).config

  assert.throws(
    () => createProvider({ ...base, allow_download: false }, { env: {} }),
    /local-onnx недоступен.*allow_download=false/,
  )
  assert.throws(
    () => createProvider({ ...base, allow_download: true }, { env: { DSH_MEMORY_NO_NETWORK: '1' } }),
    /DSH_MEMORY_NO_NETWORK=1/,
  )
  // Разрешённая загрузка не падает на preflight (веса скачаются при первом embed).
  assert.equal(createProvider({ ...base, allow_download: true }, { env: {} }).kind, 'local-onnx')

  // Скачанная модель проходит preflight даже при NO_NETWORK/allow_download=false.
  mkdirSync(join(cacheDir, 'Xenova', 'test-e5'), { recursive: true })
  writeFileSync(join(cacheDir, 'Xenova', 'test-e5', 'model.onnx'), 'weights')
  assert.equal(
    createProvider({ ...base, allow_download: false }, { env: { DSH_MEMORY_NO_NETWORK: '1' } }).kind,
    'local-onnx',
  )
})

test('apply без кэша и с allow_download=false: warn и FTS5, профиль не падает', async (t) => {
  const { apply } = await import('../packages/dsh-memory-embeddings/lib/index.js')
  const cacheDir = tempDir(t)
  const channels = []
  const logs = []
  const ctx = {
    memory: { registerSearchChannel: (channel) => { channels.push(channel); return () => {} } },
    logger: { debug: (line) => logs.push(line), info: (line) => logs.push(line), warn: (line) => logs.push(line) },
  }
  apply(ctx, { enabled: true, provider: 'local-onnx', model: MODEL, allow_download: false, cache_dir: cacheDir })
  assert.equal(channels.length, 0)
  assert.ok(logs.some((line) => line.includes('local-onnx недоступен')), logs.join('\n'))
})
