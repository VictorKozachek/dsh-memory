/**
 * Локальная ONNX/WASM-модель эмбеддингов (задачи 016/032).
 *
 * Модель и рантайм не входят в npm-пакет: `@xenova/transformers` —
 * опциональная зависимость, веса скачиваются при первом использовании в
 * `cache_dir` (по умолчанию `~/.dsh/memory/models`) и дальше работают офлайн.
 * Явное согласие — `allow_download: true`; `DSH_MEMORY_NO_NETWORK=1` запрещает
 * скачивание, но уже скачанная модель продолжает работать. Любая ошибка
 * загрузки/битый артефакт приводит к ошибке провайдера, а не к падению
 * профиля: вызывающий (apply) откатывается на FTS5.
 *
 * @module dsh-memory-embeddings/providers/local-onnx
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { networkAllowed } from '../network.js'

/** Дефолтная модель (spec 004). */
export const DEFAULT_ONNX_MODEL = 'Xenova/multilingual-e5-small'

/** Дефолтный каталог кэша модели. */
export const DEFAULT_CACHE_DIR = '~/.dsh/memory/models'

/**
 * Создать локальный ONNX-провайдер.
 *
 * @param {object} [options] — параметры.
 * @param {string} [options.model] — id модели.
 * @param {string} [options.model_path] — локальный путь (приоритетнее id).
 * @param {number} [options.dim] — ожидаемая размерность.
 * @param {boolean} [options.allow_download] — разрешено ли скачивание весов.
 * @param {string} [options.cache_dir] — каталог кэша модели.
 * @param {Function} [options.embedder] — готовый embedder (тесты/адаптер).
 * @param {Record<string, string | undefined>} [options.env] — окружение для NO_NETWORK.
 * @param {object} [options.transformers] — уже загруженный @xenova/transformers (тесты).
 * @param {(level: 'debug'|'info'|'warn', message: string) => void} [options.log] — лог прогресса.
 * @returns {{ kind: 'local-onnx', model: string, dim: number, embed: Function, cacheDir: string }} провайдер.
 */
export function createLocalOnnxProvider({
  model = DEFAULT_ONNX_MODEL,
  model_path = '',
  dim = 384,
  allow_download = true,
  cache_dir = DEFAULT_CACHE_DIR,
  embedder,
  env = process.env,
  transformers,
  log = () => {},
} = {}) {
  let resolved = embedder
  const cacheDir = expandHome(cache_dir)
  const source = model_path || model

  async function ensureEmbedder() {
    if (typeof resolved === 'function') return resolved
    if (model_path !== '') {
      if (!existsSync(model_path)) throw new Error(`dsh-memory-embeddings: локальная модель не найдена: ${model_path}`)
      resolved = await loadTransformersEmbedder(model_path, { transformers, cacheDir, allowRemote: false, log, model })
      return resolved
    }

    const cached = isModelCached(cacheDir, model)
    const networkOk = networkAllowed(env)
    const download = allow_download === true && networkOk
    if (!cached && !download) {
      const reason = !networkOk
        ? 'DSH_MEMORY_NO_NETWORK=1 запрещает скачивание'
        : 'allow_download=false'
      throw new Error(`dsh-memory-embeddings: модель ${model} не найдена в ${cacheDir} и ${reason}; используется FTS5`)
    }
    if (!cached && download) log('info', `модель ${model} не найдена в кэше — скачивание в ${cacheDir} (allow_download=true)`)
    resolved = await loadTransformersEmbedder(model, {
      transformers,
      cacheDir,
      // Если модель уже в кэше, принудительно офлайн: повторный запуск не
      // должен зависеть от сети даже при allow_download=true.
      allowRemote: download && !cached,
      log,
      model,
    })
    if (!cached && download) log('info', `модель ${model} загружена и закэширована в ${cacheDir}`)
    return resolved
  }

  return {
    kind: 'local-onnx',
    model,
    dim,
    cacheDir,
    model_path,
    allow_download,
    async embed(texts) {
      const embed = await ensureEmbedder()
      const vectors = await embed(texts)
      if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        throw new Error('dsh-memory-embeddings: локальная модель вернула неверное число векторов')
      }
      return {
        vectors: vectors.map((vector) => {
          const output = Float32Array.from(vector ?? [])
          if (output.length === 0) throw new Error('dsh-memory-embeddings: локальная модель вернула пустой вектор')
          return output
        }),
        dim: dim || vectors[0]?.length || 0,
      }
    },
  }
}

/**
 * Проверить, можно ли поднять local-onnx без сети/скачивания прямо сейчас
 * (для apply/doctor: зарегистрировать канал или сразу откатиться на FTS5).
 *
 * @param {{ model?: string, model_path?: string, allow_download?: boolean, cache_dir?: string, env?: object }} options — конфиг.
 * @returns {{ ok: boolean, reason: string, cached: boolean }} статус.
 */
export function checkLocalOnnxAvailability({
  model = DEFAULT_ONNX_MODEL,
  model_path = '',
  allow_download = true,
  cache_dir = DEFAULT_CACHE_DIR,
  env = process.env,
} = {}) {
  if (model_path !== '') {
    return existsSync(model_path)
      ? { ok: true, reason: '', cached: true }
      : { ok: false, reason: `локальная модель не найдена: ${model_path}`, cached: false }
  }
  const cacheDir = expandHome(cache_dir)
  if (isModelCached(cacheDir, model)) return { ok: true, reason: '', cached: true }
  if (allow_download !== true) return { ok: false, reason: `allow_download=false, модель ${model} не в кэше ${cacheDir}`, cached: false }
  if (!networkAllowed(env)) return { ok: false, reason: `DSH_MEMORY_NO_NETWORK=1 запрещает скачивание модели ${model}`, cached: false }
  return { ok: true, reason: '', cached: false }
}

/** Развернуть `~/` в домашний каталог. */
function expandHome(path) {
  if (typeof path !== 'string' || path.trim() === '') return resolve(DEFAULT_CACHE_DIR.replace(/^~(?=$|\/)/u, homedir()))
  const value = path.trim()
  return resolve(value.replace(/^~(?=$|\/)/u, homedir()))
}

/** Есть ли модель в кэше @xenova (проверяем типичные раскладки). */
export function isModelCached(cacheDir, model) {
  const candidates = [
    join(cacheDir, ...String(model).split('/')),
    join(cacheDir, String(model).replaceAll('/', '--')),
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && readdirSync(candidate).length > 0) return true
    } catch {
      // битый/недоступный кэш — считаем, что модели нет
    }
  }
  return false
}

/**
 * Лениво загрузить `@xenova/transformers` и собрать embedder.
 *
 * @param {string} source — id/локальный путь модели.
 * @param {{ transformers?: object, cacheDir: string, allowRemote: boolean, log?: Function, model?: string }} options — загрузка.
 * @returns {Promise<(texts: string[]) => Promise<Float32Array[]>>} embedder.
 */
async function loadTransformersEmbedder(source, { transformers, cacheDir, allowRemote, log = () => {}, model = source }) {
  let module = transformers
  if (module === undefined) {
    try {
      module = await import('@xenova/transformers')
    } catch {
      throw new Error('dsh-memory-embeddings: local-onnx требует @xenova/transformers; канал выключен, используется FTS5')
    }
  }
  const pipeline = module.pipeline ?? module.default?.pipeline
  if (typeof pipeline !== 'function') {
    throw new Error('dsh-memory-embeddings: @xenova/transformers не экспортирует pipeline')
  }
  if (module.env !== undefined) {
    // Кэш нужен только для скачивания; локальный model_path не требует
    // создания ~/.dsh/... (и не должен падать в read-only окружении).
    if (allowRemote === true) mkdirSync(cacheDir, { recursive: true })
    module.env.cacheDir = cacheDir
    module.env.allowRemoteModels = allowRemote === true
    module.env.allowLocalModels = true
  }
  const progress = (event) => {
    if (event?.status === 'progress') {
      const percent = Number(event.progress)
      log('debug', `загрузка модели ${model}: ${Number.isFinite(percent) ? `${Math.round(percent)}%` : '…'}`)
    } else if (event?.status === 'done') {
      log('debug', `файл модели ${model} готов`)
    }
  }
  const extractor = await pipeline('feature-extraction', source, { progress_callback: progress })
  return async (texts) => {
    const output = await extractor(texts, { pooling: 'mean', normalize: true })
    const data = output?.data ?? output
    if (!Array.isArray(data) && !(data instanceof Float32Array)) {
      throw new Error('dsh-memory-embeddings: локальная модель вернула неожиданный формат')
    }
    const values = Array.from(data)
    const size = Math.max(1, Math.floor(values.length / texts.length))
    return texts.map((_, index) => Float32Array.from(values.slice(index * size, (index + 1) * size)))
  }
}
