/**
 * Автоиндексация при первом ходе (задача 036, spec 004).
 *
 * Плагин не должен индексировать воркспейс синхронно на старте: это замедлило
 * бы первый ход. Если индекс пуст, планировщик ставит `indexWorkspace` в
 * фоновую очередь (`setTimeout(0)`) и сразу возвращает управление. Повторный
 * ход видит непустой индекс и ничего не делает; ошибка логируется, ход не
 * падает, следующая попытка — на следующем ходе.
 *
 * @module dsh-memory/autoindex
 */

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
 * Создать планировщик автоиндексации на контекст хука.
 *
 * @param {object} [options] — параметры.
 * @param {Function} [options.indexer] — функция индексации (для тестов).
 * @param {(level: 'debug'|'info'|'warn', message: string) => void} [options.logger] — лог.
 * @param {(callback: () => void) => unknown} [options.schedule] — очередь (по умолчанию setTimeout 0).
 * @param {() => number} [options.now] — часы индексатора.
 * @returns {{ maybeSchedule: (input: { store: object, workspace: string, config?: object, env?: object }) => boolean }} планировщик.
 */
export function createAutoindexScheduler({
  indexer = indexWorkspace,
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
    // После ошибки индекс мог остаться частичным (entries > 0), но повтор
    // всё равно нужен: state.failed переживает проверку непустого индекса.
    if (entries > 0 && previous?.failed !== true) return false
    const state = { scheduled: true, running: false, failed: previous?.failed === true }
    states.set(store, state)
    schedule(() => {
      state.scheduled = false
      state.running = true
      try {
        logger('info', `автоиндексация: индекс пуст, индексирую ${workspace}`)
        const summary = indexer({
          workspace,
          store,
          include: config.index?.include,
          exclude: config.index?.exclude,
          maxChunkTokens: config.index?.max_chunk_tokens,
          ...(now === undefined ? {} : { now }),
        })
        logger('info', `автоиндексация: проиндексировано ${summary.indexed}, без изменений ${summary.unchanged}, файлов ${summary.files}`)
        state.failed = false
      } catch (error) {
        state.failed = true
        logger('warn', `автоиндексация не выполнена: ${error instanceof Error ? error.message : String(error)}; повтор на следующем ходе`)
      } finally {
        state.running = false
      }
    })
    return true
  }

  return { maybeSchedule }
}
