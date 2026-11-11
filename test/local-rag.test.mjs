/**
 * Тесты первого запуска локального RAG (задача 033): backfill с прогрессом,
 * повтор по entries-changed, doctor (кэш/статус/размерность/векторы/NO_NETWORK).
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { backfillEmbeddings } from '../packages/dsh-memory-embeddings/lib/backfill.js'
import { createAsyncChannel } from '../packages/dsh-memory-embeddings/lib/channel.js'
import { resolveConfig } from '../packages/dsh-memory-embeddings/lib/config.js'
import { doctorReport } from '../packages/dsh-memory-embeddings/lib/doctor.js'
import { doctorCommand } from '../packages/dsh-memory-embeddings/bin/doctor.js'
import { isModelCached } from '../packages/dsh-memory-embeddings/lib/providers/local-onnx.js'
import { openStore } from '../lib/store.js'
import { searchMemoryAsync } from '../lib/search.js'

const MODEL = 'Xenova/multilingual-e5-small'

/** Временное хранилище. */
function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-local-rag-'))
  const store = openStore({ dbPath: dir, namespace: 'demo' })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, store }
}

/** Запись. */
function add(store, title, text) {
  return store.insertEntry({ kind: 'doc', title, text, status: 'verified', confidence: 1 })
}

test('backfill существующих записей пишет прогресс в лог', async (t) => {
  const { store } = tempStore(t)
  const first = add(store, 'Индексатор', 'индексатор обходит файлы')
  const second = add(store, 'Память', 'память проекта в SQLite')
  const logs = []
  const provider = {
    model: 'mock',
    async embed(texts) {
      return { vectors: texts.map(() => Float32Array.from([1, 0])), dim: 2 }
    },
  }
  const result = await backfillEmbeddings({ store, provider, log: (level, message) => logs.push(`${level}:${message}`) })
  assert.equal(result.embedded, 2)
  assert.equal(result.failed, 0)
  assert.equal(store.listEmbeddings(provider.model).length, 2)
  assert.ok(logs.some((line) => line.includes(`досчёт векторов 2 записей`)), logs.join('\n'))
  assert.ok(logs.some((line) => line.includes('прогресс 2/2')), logs.join('\n'))
  assert.ok(logs.some((line) => line.includes('досчёт завершён')), logs.join('\n'))
  assert.ok([first.id, second.id].every((id) => store.getEmbedding(id, provider.model) !== null))
})

test('ошибка эмбеддинга не ломает поиск; entries-changed запускает повтор', async (t) => {
  const { store } = tempStore(t)
  const id = add(store, 'Индексатор', 'индексатор обходит файлы').id
  let fail = true
  const provider = {
    model: 'mock',
    async embed(texts) {
      if (fail) throw new Error('model download failed')
      return { vectors: texts.map(() => Float32Array.from([1, 0])), dim: 2 }
    },
  }
  const channel = createAsyncChannel({ provider, model: provider.model })
  // Первый поиск: модель недоступна, ошибка канала проглатывается, FTS-ответ жив.
  const first = await searchMemoryAsync(store, { query: 'индексатор' }, { channels: [channel] })
  assert.ok(first.some((row) => row.id === id))
  assert.equal(store.listEmbeddings(provider.model).length, 0)
  fail = false
  channel.entriesChanged()
  const results = await searchMemoryAsync(store, { query: 'индексатор' }, { channels: [channel] })
  assert.ok(results.some((row) => row.id === id))
  assert.ok(store.listEmbeddings(provider.model).some((row) => row.entryId === id))
})

test('doctor: провайдер, кэш, статус, размерность и число векторов', (t) => {
  const { store } = tempStore(t)
  add(store, 'Индексатор', 'индексатор обходит файлы')
  const cacheDir = mkdtempSync(join(tmpdir(), 'dsh-memory-doctor-cache-'))
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }))
  mkdirSync(join(cacheDir, 'Xenova', 'multilingual-e5-small'), { recursive: true })
  writeFileSync(join(cacheDir, 'Xenova', 'multilingual-e5-small', 'model.onnx'), 'weights')
  assert.equal(isModelCached(cacheDir, MODEL), true)

  const config = resolveConfig({ enabled: true, provider: 'local-onnx', model: MODEL, cache_dir: cacheDir }).config
  const lines = doctorReport(config, {
    provider: { kind: 'local-onnx', model: MODEL, cacheDir, dim: 384 },
    store,
  })
  const text = lines.map((line) => line.message).join('\n')
  assert.match(text, new RegExp(`provider=local-onnx`))
  assert.match(text, new RegExp(`cache_dir=${cacheDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(text, /статус=скачана/)
  assert.match(text, /размерность=384/)
  assert.match(text, /векторов: 0, без векторов: 1/)
  assert.ok(!lines.some((line) => line.message.includes('первая загрузка')))
})

test('doctor: нет кэша — одно предупреждение о первой загрузке; allow_download=false — FTS5', (t) => {
  const { store } = tempStore(t)
  const cacheDir = mkdtempSync(join(tmpdir(), 'dsh-memory-doctor-empty-'))
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }))
  const config = resolveConfig({ enabled: true, provider: 'local-onnx', model: MODEL, cache_dir: cacheDir, allow_download: true }).config
  const lines = doctorReport(config, { provider: { kind: 'local-onnx', model: MODEL, cacheDir, dim: 384 }, store })
  const warnings = lines.filter((line) => line.level === 'warn' && line.message.includes('первая загрузка'))
  assert.equal(warnings.length, 1, 'ровно одно предупреждение, без спама')
  assert.match(warnings[0].message, /100 МБ/)
  assert.match(warnings[0].message, /Hugging Face/)

  const noDownload = doctorReport(
    resolveConfig({ enabled: true, provider: 'local-onnx', model: MODEL, cache_dir: cacheDir, allow_download: false }).config,
    { provider: { kind: 'local-onnx', model: MODEL, cacheDir, dim: 384 }, store },
  )
  assert.ok(noDownload.some((line) => line.level === 'warn' && line.message.includes('allow_download=false')))
})


test('doctorCommand с store показывает число векторов и статус кэша', (t) => {
  const { store } = tempStore(t)
  add(store, 'Индексатор', 'индексатор обходит файлы')
  const cacheDir = mkdtempSync(join(tmpdir(), 'dsh-memory-doctor-command-'))
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }))
  const configFile = join(cacheDir, 'config.json')
  writeFileSync(configFile, JSON.stringify({ enabled: true, provider: 'local-onnx', model: MODEL, cache_dir: cacheDir, allow_download: false }))
  const { code, lines } = doctorCommand(['--config', configFile], {}, { store })
  assert.equal(code, 0)
  const text = lines.join('\n')
  assert.match(text, /local-onnx/)
  assert.match(text, /статус=нет в кэше/)
  assert.match(text, /векторов: 0, без векторов: 1/)
})
