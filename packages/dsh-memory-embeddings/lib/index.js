/**
 * Хост-половина опционального пакета `dsh-memory-embeddings` (задача 016).
 *
 * Пакет монтируется после `dsh-memory`, получает сервис `memory` и:
 * - при `enabled:false` (дефолт) ничего не регистрирует — поиск остаётся FTS5;
 * - при `enabled:true` создаёт провайдер, досчитывает отсутствующие векторы и
 *   (для локального синхронного провайдера) регистрирует канал гибридного
 *   поиска через `memory.registerSearchChannel`;
 * - ошибки конфига/провайдера не роняют профиль: пишет предупреждение и
 *   оставляет FTS5.
 *
 * @module dsh-memory-embeddings
 */

import { createAsyncChannel, createLocalChannel } from './channel.js'
import { resolveConfig } from './config.js'
import { doctorReport } from './doctor.js'
import { createLocalProvider } from './providers/local.js'
import { createLocalOnnxProvider } from './providers/local-onnx.js'
import { createOllamaProvider } from './providers/ollama.js'
import { createOpenAiProvider } from './providers/openai.js'

export const name = 'dsh-memory-embeddings'

/** Пакет живёт на сервисе памяти основного пакета. */
export const inject = ['memory']

export { backfillEmbeddings } from './backfill.js'
export { cosineSimilarity, createAsyncChannel, createLocalChannel } from './channel.js'
export { DEFAULT_CONFIG, PROVIDERS, resolveConfig } from './config.js'
export { doctorReport } from './doctor.js'
export { embedLocal, createLocalProvider } from './providers/local.js'
export { createLocalOnnxProvider } from './providers/local-onnx.js'
export { createOllamaProvider } from './providers/ollama.js'
export { createOpenAiProvider, redact } from './providers/openai.js'

/**
 * Создать провайдер по конфигу. Ошибки — с понятным текстом без значений
 * ключей; вызывающий (apply) их ловит и откатывается на FTS5.
 *
 * @param {ReturnType<typeof resolveConfig>['config']} config — конфиг.
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: Function }} [options] — окружение/транспорт для тестов.
 * @returns {{ kind: 'local' | 'ollama' | 'openai-compatible', model: string, embed: Function, embedOne?: Function }} провайдер.
 */
export function createProvider(config, { env = process.env, fetchImpl } = {}) {
  if (!config.enabled) throw new Error('dsh-memory-embeddings: пакет выключен')
  if (config.provider === '') throw new Error('dsh-memory-embeddings: provider не задан')
  if (config.model === '') throw new Error('dsh-memory-embeddings: model не задан')
  switch (config.provider) {
    case 'local':
      return createLocalProvider({ model: config.model })
    case 'local-onnx':
      return createLocalOnnxProvider({ model: config.model, model_path: config.model_path })
    case 'ollama':
      return createOllamaProvider({
        base_url: config.base_url || undefined,
        model: config.model,
        env,
        fetchImpl,
        timeout_ms: config.timeout_ms,
        batch_size: config.batch_size,
      })
    case 'openai-compatible':
      if (config.base_url === '') throw new Error('dsh-memory-embeddings: base_url не задан для openai-compatible')
      return createOpenAiProvider({
        base_url: config.base_url,
        model: config.model,
        api_key_env: config.api_key_env,
        env,
        fetchImpl,
        timeout_ms: config.timeout_ms,
        max_retries: config.max_retries,
        batch_size: config.batch_size,
      })
    default:
      throw new Error(`dsh-memory-embeddings: неизвестный provider "${config.provider}"`)
  }
}

/**
 * Зарегистрировать пакет в cordis.
 *
 * @param {object | undefined} ctx — контекст cordis.
 * @param {object} [config] — конфиг ряда `dsh-memory-embeddings`.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const { config: options, warnings } = resolveConfig(config)
  for (const warning of warnings) log(ctx, 'warn', warning)
  if (!options.enabled) {
    log(ctx, 'debug', 'embeddings выключены: используется FTS5')
    return
  }

  const memory = ctx?.memory ?? ctx?.get?.('memory', false)
  if (!memory || typeof memory.registerSearchChannel !== 'function') {
    log(ctx, 'warn', 'embeddings: нет сервиса memory с registerSearchChannel — используется FTS5')
    return
  }

  let provider
  try {
    provider = createProvider(options, { env: process.env })
  } catch (error) {
    log(ctx, 'warn', `embeddings: провайдер не создан (${error instanceof Error ? error.message : String(error)}); используется FTS5`)
    return
  }

  for (const line of doctorReport(options, { provider })) log(ctx, line.level, line.message)

  try {
    // Канал получает store из каждого вызова memory.search — не замыкаем
    // воркспейс/namespace на момент загрузки плагина.
    const channel = provider.kind === 'local'
      ? createLocalChannel({ provider, model: provider.model, weight: options.hybrid_weight })
      : createAsyncChannel({
        provider,
        model: provider.model,
        weight: options.hybrid_weight,
        batch_size: options.batch_size,
        log: (level, message) => log(ctx, level, message),
      })
    const off = memory.registerSearchChannel(channel)
    if (typeof ctx?.effect === 'function') ctx.effect(() => off)
  } catch (error) {
    log(ctx, 'warn', `embeddings: канал не зарегистрирован (${error instanceof Error ? error.message : String(error)}); используется FTS5`)
  }
}
/** Записать в лог, если он есть; диагностика не роняет плагин. */
function log(ctx, level, message) {
  try {
    const logger = ctx?.logger
    const write = logger?.[level] ?? logger?.info
    if (typeof write === 'function') write.call(logger, `[${name}] ${message}`)
  } catch {
    // молчим
  }
}
