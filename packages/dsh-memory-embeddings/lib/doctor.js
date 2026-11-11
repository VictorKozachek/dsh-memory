/**
 * Диагностика эмбеддингов (задачи 016/033): без ключей в выводе. Показывает
 * провайдера, модель, кэш/статус, размерность и число векторов; предупреждение
 * о первой загрузке — один раз за вызов, без спама.
 *
 * @module dsh-memory-embeddings/doctor
 */

import { existsSync } from 'node:fs'

import { networkAllowed } from './network.js'
import { DEFAULT_CACHE_DIR, isModelCached } from './providers/local-onnx.js'

/**
 * Собрать строки диагностики.
 *
 * @param {object} config — разрешённый конфиг пакета.
 * @param {{ provider?: object | null, store?: object | null, env?: object }} [options] — провайдер, хранилище, окружение.
 * @returns {Array<{ level: 'info' | 'warn', message: string }>} строки.
 */
export function doctorReport(config, { provider = null, store = null, env = process.env } = {}) {
  const lines = []
  if (!config.enabled) {
    lines.push({ level: 'info', message: 'embeddings: выключены (чистый FTS5)' })
    return lines
  }
  if (provider === null) {
    lines.push({ level: 'warn', message: 'embeddings: включены, но провайдер не создан — используется FTS5' })
    return lines
  }
  lines.push({ level: 'info', message: `embeddings: включены (provider=${provider.kind}, model=${provider.model})` })
  if (provider.kind === 'local' || provider.kind === 'local-onnx') {
    if (provider.kind === 'local') {
      lines.push({ level: 'info', message: 'локальные эмбеддинги: сеть и ключи не используются' })
    } else {
      const cacheDir = provider.cacheDir ?? config.cache_dir ?? DEFAULT_CACHE_DIR
      const modelPath = provider.model_path ?? config.model_path ?? ''
      const cached = modelPath !== '' ? existsSync(modelPath) : isModelCached(cacheDir, provider.model)
      lines.push({
        level: 'info',
        message: cached
          ? 'локальные эмбеддинги: модель в кэше, сеть и ключи не используются'
          : 'локальные эмбеддинги: ключи не используются; модель ещё не в кэше — для загрузки нужна сеть',
      })
      lines.push({
        level: 'info',
        message: `local-onnx: cache_dir=${cacheDir}${modelPath === '' ? '' : `, model_path=${modelPath}`}, статус=${cached ? 'скачана' : 'нет в кэше'}`,
      })
      if (typeof provider.dim === 'number' && provider.dim > 0) {
        lines.push({ level: 'info', message: `local-onnx: размерность=${provider.dim}` })
      }
      if (!cached) {
        if (modelPath !== '') {
          lines.push({ level: 'warn', message: `local-onnx: model_path не найден: ${modelPath}; остаётся FTS5` })
        } else if (!networkAllowed(env)) {
          lines.push({ level: 'warn', message: `DSH_MEMORY_NO_NETWORK=1: скачивание модели ${provider.model} запрещено; остаётся FTS5` })
        } else if (config.allow_download === true) {
          lines.push({
            level: 'warn',
            message: `первая загрузка модели ${provider.model}: ~100 МБ из Hugging Face в ${cacheDir} (allow_download=true)`,
          })
        } else {
          lines.push({ level: 'warn', message: `модель ${provider.model} не найдена в ${cacheDir}; allow_download=false — остаётся FTS5` })
        }
      }
    }
  } else if (provider.kind === 'ollama') {
    lines.push({ level: 'warn', message: `запросы и тексты записей отправляются локальной Ollama (${provider.model}); при DSH_MEMORY_NO_NETWORK=1 канал отключается` })
  } else {
    lines.push({ level: 'warn', message: `запросы и тексты записей будут отправлены провайдеру (${provider.kind}, model=${provider.model}); ключ берётся из env ${config.api_key_env} (значение не показывается)` })
  }
  if (store !== null && typeof store.listEmbeddings === 'function') {
    try {
      const vectors = store.listEmbeddings(provider.model).length
      const missing = typeof store.listEntriesWithoutEmbedding === 'function'
        ? store.listEntriesWithoutEmbedding(provider.model).length
        : null
      lines.push({
        level: 'info',
        message: `векторов: ${vectors}${missing === null ? '' : `, без векторов: ${missing}`}`,
      })
    } catch {
      lines.push({ level: 'warn', message: 'не удалось посчитать векторы в хранилище' })
    }
  }
  return lines
}
