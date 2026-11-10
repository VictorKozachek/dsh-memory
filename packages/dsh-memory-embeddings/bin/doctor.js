#!/usr/bin/env node
/**
 * `dsh-memory-embeddings doctor` — диагностика опционального пакета без
 * создания провайдера и без сетевых вызовов: печатает, включён ли канал, какой
 * провайдер выбран, есть ли ключ в env (только имя/наличие), и предупреждение
 * об отправке текста провайдеру. Команда `doctor` основного пакета — отдельная
 * задача; этот бинарь даёт проверяемую точку уже сейчас.
 *
 * @module dsh-memory-embeddings/bin/doctor
 */

import { readFileSync } from 'node:fs'

import { resolveConfig } from '../lib/config.js'
import { doctorReport } from '../lib/doctor.js'

/**
 * Выполнить команду.
 *
 * @param {string[]} argv — аргументы после имени команды.
 * @param {Record<string, string | undefined>} env — окружение.
 * @returns {{ code: number, lines: string[] }} код и строки.
 */
export function doctorCommand(argv = [], env = process.env) {
  let config = env.DSH_MEMORY_EMBEDDINGS_CONFIG ?? ''
  const lines = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--config') config = argv[++index] ?? ''
    else if (argument.startsWith('--config=')) config = argument.slice('--config='.length)
    else if (argument === '--help' || argument === '-h') {
      return { code: 0, lines: ['dsh-memory-embeddings doctor [--config <файл.json>]'] }
    } else {
      return { code: 2, lines: [`dsh-memory-embeddings: неизвестный аргумент "${argument}"`] }
    }
  }

  let raw = {}
  if (config !== '') {
    try {
      raw = JSON.parse(readFileSync(config, 'utf8'))
    } catch (error) {
      return { code: 1, lines: [`dsh-memory-embeddings: конфиг не прочитан: ${config} (${error instanceof Error ? error.message : String(error)})`] }
    }
  }
  const { config: resolved, warnings } = resolveConfig(raw)
  lines.push(...warnings)
  const enabled = resolved.enabled
  const provider = enabled && resolved.provider !== '' && resolved.model !== ''
    ? { kind: resolved.provider, model: resolved.model }
    : null
  for (const line of doctorReport(resolved, { provider })) {
    lines.push(`${line.level === 'warn' ? 'ВНИМАНИЕ: ' : ''}${line.message}`)
  }
  if (enabled && resolved.api_key_env !== '' && resolved.provider !== 'local' && resolved.provider !== 'local-onnx') {
    lines.push(env[resolved.api_key_env] ? `ключ найден в env ${resolved.api_key_env} (значение не показывается)` : `ключа нет в env ${resolved.api_key_env} — канал не включится, FTS5`)
  }
  if (resolved.provider === 'local-onnx' && resolved.model_path === '') {
    lines.push('local-onnx: model_path пуст — нужен локальный ONNX-артефакт/embedder')
  }
  return { code: 0, lines }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('doctor.js')) {
  const { code, lines } = doctorCommand(process.argv.slice(2), process.env)
  console.log(lines.join('\n'))
  process.exit(code)
}
