/**
 * Автоиндексация при первом ходе (задача 036, spec 004).
 *
 * Плагин не должен индексировать воркспейс синхронно на старте: это замедлило
 * бы первый ход. Если индекс пуст, планировщик запускает `indexWorkspace` в
 * worker-потоке (event loop хода свободен) и сразу возвращает управление.
 * После успешного прогона (даже с 0 файлов) повторно не запускается; ошибка
 * логируется, ход не падает, следующая попытка — на следующем ходе. Изменения
 * документов после первого успеха — ручной `dsh-memory index`/следующая задача.
 *
 * @module dsh-memory/autoindex
 */

import { dirname } from 'node:path'
import { Worker } from 'node:worker_threads'

import { indexWorkspace } from './indexer.js'

/** Переменная окружения для отключения автоиндексации. */
export const AUTOINDEX_ENV = 'DSH_MEMORY_AUTOINDEX'

const OFF_VALUES = new Set(['off', 'false', '0', 'no', 'disabled'])

/**
 * Включена ли автоиндексация.
 *
 * @param {Record<string, string | undefined>} [env] — окружение.
 * @param {object} [config] — конфиг плагина.
 * @returns {boolean} true, если нужно индексировать.
 */
export function autoindexEnabled(env = process.env, config = {}) {
  const raw = env?.[AUTOINDEX_ENV]
  if (raw !== undefined && OFF_VALUES.has(String(raw).trim().toLowerCase())) return false
  return config?.index?.autoindex !== false
}

/**
 * Запустить `indexWorkspace` в worker-потоке, чтобы не держать event loop хода.
 *
 * @param {{ store: object, workspace: string, include?: string[], exclude?: string[], maxChunkTokens?: number }} input — параметры.
 * @returns {Promise<object>} summary индексатора.
 */
export function indexInWorker({ store, workspace, include, exclude, maxChunkTokens } = {}) {
  if (!store || typeof store.file !== 'string') {
    return Promise.reject(new Error('автоиндексация: у store нет file для worker'))
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./index-worker.js', import.meta.url), {
      workerData: {
        dbPath: dirname(store.file),
        namespace: store.namespace,
        workspace,
        include,
        exclude,
        maxChunkTokens,
      },
    })
    let settled = false
    const finish = (error, summary) => {
      if (settled) return
      settled = true
      worker.terminate().catch(() => {})
      if (error !== null) reject(error)
      else resolve(summary)
    }
    worker.once('message', (message) => {
      if (message?.ok === true) finish(null, message.summary)
      else finish(new Error(message?.error ?? 'worker не вернул summary'))
    })
    worker.once('error', (error) => finish(error))
    worker.once('exit', (code) => {
      if (code !== 0) finish(new Error(`worker индексации завершился с кодом ${code}`))
    })
  })
}

/**
 * Создать планировщик автоиндексации на контекст хука.
 *
 * @param {object} [options] — параметры.
 * @param {Function} [options.indexer] — функция индексации (для тестов; по умолчанию worker).
 * @param {(level: 'debug'|'info'|'warn', message: string) => void} [options.logger] — лог.
 * @param {(callback: () => void) => unknown} [options.schedule] — очередь (по умолчанию setTimeout 0).
 * @param {() => number} [options.now] — часы индексатора.
 * @returns {{ maybeSchedule: (input: { store: object, workspace: string, config?: object, env?: object }) => boolean }} планировщик.
 */
export function createAutoindexScheduler({
  indexer = indexInWorker,
  logger = () => {},
  schedule = (callback) => setTimeout(callback, 0),
  now,
} = {}) {
  const states = new WeakMap()

  const maybeSchedule = ({ store, workspace, config = {}, env = process.env } = {}) => {
    if (!autoindexEnabled(env, config)) return false
    if (!store || typeof store.countEntries !== 'function' || typeof workspace !== 'string' || workspace.trim() === '') return false
    let entries
    try {
      entries = store.countEntries()
    } catch (error) {
      logger('warn', `автоиндексация: не удалось проверить индекс: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    const previous = states.get(store)
    if (previous !== undefined && (previous.scheduled || previous.running)) return false
    if (previous?.completed === true && previous?.failed !== true) return false
    // После ошибки индекс мог остаться частичным (entries > 0), но повтор
    // всё равно нужен: state.failed переживает проверку непустого индекса.
    if (entries > 0 && previous?.failed !== true) return false
    const state = { scheduled: true, running: false, completed: previous?.completed === true, failed: previous?.failed === true }
    states.set(store, state)
    schedule(() => {
      state.scheduled = false
      state.running = true
      const succeed = (summary) => {
        logger('info', `автоиндексация: проиндексировано ${summary.indexed}, без изменений ${summary.unchanged}, файлов ${summary.files}`)
        state.failed = false
        state.completed = true
        state.running = false
      }
      const fail = (error) => {
        state.failed = true
        state.completed = false
        state.running = false
        logger('warn', `автоиндексация не выполнена: ${error instanceof Error ? error.message : String(error)}; повтор на следующем ходе`)
      }
      try {
        logger('info', `автоиндексация: индекс пуст, индексирую ${workspace}`)
        const result = indexer({
          workspace,
          store,
          include: config.index?.include,
          exclude: config.index?.exclude,
          maxChunkTokens: config.index?.max_chunk_tokens,
          ...(now === undefined ? {} : { now }),
        })
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          result.then(succeed, fail)
        } else {
          succeed(result)
        }
      } catch (error) {
        fail(error)
      }
    })
    return true
  }

  return { maybeSchedule }
}
