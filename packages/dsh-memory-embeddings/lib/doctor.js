/**
 * Диагностика эмбеддингов (задача 016): без ключей в выводе. Будущий
 * `dsh-memory doctor` может показать эти строки; сейчас пакет пишет их в лог при
 * включении.
 *
 * @module dsh-memory-embeddings/doctor
 */

/**
 * Собрать строки диагностики.
 *
 * @param {object} config — разрешённый конфиг пакета.
 * @param {{ provider?: { kind: string, model: string } | null }} [options] — созданный провайдер.
 * @returns {Array<{ level: 'info' | 'warn', message: string }>} строки.
 */
export function doctorReport(config, { provider = null } = {}) {
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
  if (provider.kind === 'local') {
    lines.push({ level: 'info', message: 'локальные эмбеддинги: сеть и ключи не используются' })
  } else if (provider.kind === 'ollama') {
    lines.push({ level: 'warn', message: `ВНИМАНИЕ: запросы и тексты записей отправляются локальной Ollama (${provider.model}); при DSH_MEMORY_NO_NETWORK=1 канал отключается` })
  } else {
    lines.push({ level: 'warn', message: `ВНИМАНИЕ: запросы и тексты записей будут отправлены провайдеру (${provider.kind}, model=${provider.model}); ключ берётся из env ${config.api_key_env} (значение не показывается)` })
  }
  return lines
}
