/**
 * Конфиг опционального пакета эмбеддингов (задача 016).
 *
 * @module dsh-memory-embeddings/config
 */

/** Провайдеры, которые знает пакет. */
export const PROVIDERS = Object.freeze(['local', 'local-onnx', 'ollama', 'openai-compatible'])

/** Дефолты ряда `dsh-memory-embeddings`. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  provider: 'local-onnx',
  base_url: '',
  model: 'Xenova/multilingual-e5-small',
  model_path: '',
  allow_download: true,
  cache_dir: '~/.dsh/memory/models',
  api_key_env: 'DSH_MEMORY_EMBEDDINGS_API_KEY',
  batch_size: 32,
  timeout_ms: 5_000,
  max_retries: 2,
  hybrid_weight: 0.5,
})

/**
 * Разобрать конфиг: невалидные поля заменяются дефолтами с предупреждениями,
 * загрузка профиля не падает.
 *
 * @param {object} [raw] — конфиг ряда.
 * @returns {{ config: typeof DEFAULT_CONFIG, warnings: string[] }} конфиг и предупреждения.
 */
export function resolveConfig(raw = {}) {
  const config = { ...DEFAULT_CONFIG }
  const warnings = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config, warnings: ['конфиг эмбеддингов: ожидался объект — беру дефолты'] }
  }

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') config.enabled = raw.enabled
    else warnings.push('embeddings.enabled должен быть boolean — оставляю false')
  }
  if (raw.provider !== undefined) {
    if (typeof raw.provider === 'string' && (raw.provider === '' || PROVIDERS.includes(raw.provider))) {
      config.provider = raw.provider
    } else {
      warnings.push(`embeddings.provider должен быть одним из ${PROVIDERS.join(', ')} — оставляю пусто`)
    }
  }
  for (const field of ['base_url', 'model', 'model_path', 'cache_dir', 'api_key_env']) {
    if (raw[field] !== undefined) {
      if (typeof raw[field] === 'string') config[field] = raw[field].trim()
      else warnings.push(`embeddings.${field} должен быть строкой`)
    }
  }
  if (raw.allow_download !== undefined) {
    if (typeof raw.allow_download === 'boolean') config.allow_download = raw.allow_download
    else warnings.push('embeddings.allow_download должен быть boolean')
  }
  for (const field of ['batch_size', 'timeout_ms']) {
    if (raw[field] !== undefined) {
      if (Number.isSafeInteger(raw[field]) && raw[field] > 0) config[field] = raw[field]
      else warnings.push(`embeddings.${field} должен быть целым > 0`)
    }
  }
  if (raw.max_retries !== undefined) {
    if (Number.isSafeInteger(raw.max_retries) && raw.max_retries >= 0) config.max_retries = raw.max_retries
    else warnings.push('embeddings.max_retries должен быть целым ≥ 0')
  }
  if (raw.hybrid_weight !== undefined) {
    if (typeof raw.hybrid_weight === 'number' && Number.isFinite(raw.hybrid_weight) && raw.hybrid_weight >= 0 && raw.hybrid_weight <= 1) {
      config.hybrid_weight = raw.hybrid_weight
    } else {
      warnings.push('embeddings.hybrid_weight должен быть числом 0..1')
    }
  }

  if (config.enabled) {
    if (config.provider === '') warnings.push('embeddings.enabled=true, но provider пуст — канал не включится, останется FTS5')
    if (config.model === '') warnings.push('embeddings.enabled=true, но model пуст — канал не включится, останется FTS5')
    if (config.provider === 'openai-compatible' && config.base_url === '') {
      warnings.push('embeddings.provider=openai-compatible, но base_url пуст — канал не включится, останется FTS5')
    }
    if (config.provider === 'local-onnx' && config.model_path === '' && config.allow_download === false) {
      warnings.push('embeddings.provider=local-onnx: allow_download=false и model_path пуст — нужна скачанная модель в cache_dir')
    }
  }
  return { config: Object.freeze(config), warnings }
}
