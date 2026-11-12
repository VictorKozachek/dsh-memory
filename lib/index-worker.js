/**
 * Worker-поток для фоновой индексации (задача 036): синхронный
 * `indexWorkspace` не должен держать event loop хода. Worker открывает своё
 * соединение к тому же SQLite (WAL) и сообщает summary/ошибку.
 *
 * @module dsh-memory/index-worker
 */

import { parentPort, workerData } from 'node:worker_threads'

import { indexWorkspace } from './indexer.js'
import { openStore } from './store.js'

try {
  const store = openStore({ dbPath: workerData.dbPath, namespace: workerData.namespace })
  try {
    const summary = indexWorkspace({
      workspace: workerData.workspace,
      store,
      include: workerData.include,
      exclude: workerData.exclude,
      maxChunkTokens: workerData.maxChunkTokens,
    })
    parentPort.postMessage({ ok: true, summary })
  } finally {
    store.close()
  }
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
}
