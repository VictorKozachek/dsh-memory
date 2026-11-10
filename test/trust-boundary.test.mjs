/**
 * Границы доверия дизайна эмбеддингов (задача 021): в основном пакете нет
 * сетевого кода и сетевых зависимостей; `DSH_MEMORY_NO_NETWORK` запрещает
 * egress для опционального пакета; дизайн-док на месте.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { NO_NETWORK_ENV, assertNetworkAllowed, networkAllowed } from '../lib/network.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Паттерны сетевого кода, которых в основном пакете быть не должно. */
const NETWORK_PATTERNS = [
  { name: 'node:http(s)', pattern: /(?:from|import)\s*['"]node:https?['"]/u },
  { name: 'node:net', pattern: /(?:from|import)\s*['"]node:net['"]/u },
  { name: 'node:tls', pattern: /(?:from|import)\s*['"]node:tls['"]/u },
  { name: 'node:dgram', pattern: /(?:from|import)\s*['"]node:dgram['"]/u },
  { name: 'node:dns', pattern: /(?:from|import)\s*['"]node:dns(?:\/promises)?['"]/u },
  { name: 'fetch()', pattern: /\bfetch\s*\(/u },
  { name: 'axios/undici/openai', pattern: /(?:from|import|require\()\s*['"](?:axios|undici|openai|node-fetch)['"]/u },
  { name: 'dynamic import network', pattern: /import\s*\(\s*['"](?:node:https?|node:net|node:tls|axios|undici|openai|node-fetch)['"]/u },
  { name: 'require network', pattern: /require\s*\(\s*['"](?:node:https?|node:net|node:tls|axios|undici|openai|node-fetch)['"]/u },
]

/** Рекурсивно собрать .js-файлы в каталоге. */
function listJs(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listJs(path))
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path)
  }
  return files
}

test('в lib/** и bin/ основного пакета нет сетевого кода (включая динамические импорты)', () => {
  for (const file of [...listJs(join(ROOT, 'lib')), ...listJs(join(ROOT, 'bin'))]) {
    const content = readFileSync(file, 'utf8')
    const label = file.slice(ROOT.length + 1)
    for (const { name, pattern } of NETWORK_PATTERNS) {
      assert.doesNotMatch(content, pattern, `${label}: найден сетевой код (${name})`)
    }
  }
})

test('в package.json нет сетевых зависимостей', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const dependencies = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }
  for (const name of Object.keys(dependencies)) {
    assert.doesNotMatch(name, /(?:axios|undici|openai|node-fetch|http|https|got|superagent)/iu, `сетевая зависимость ${name}`)
  }
  assert.ok(pkg.exports['./network'], 'опциональный пакет должен импортировать dsh-memory/network')
})

test('DSH_MEMORY_NO_NETWORK запрещает сеть, пустое значение — разрешает', () => {
  for (const value of ['1', 'true', 'ON', 'yes', ' 1 ']) {
    assert.equal(networkAllowed({ [NO_NETWORK_ENV]: value }), false, `значение ${value}`)
    assert.throws(() => assertNetworkAllowed({ [NO_NETWORK_ENV]: value }), /сеть запрещена/)
  }
  for (const value of [undefined, '', '0', 'false', 'off', 'no']) {
    assert.equal(networkAllowed({ [NO_NETWORK_ENV]: value }), true, `значение ${value}`)
    assert.doesNotThrow(() => assertNetworkAllowed({ [NO_NETWORK_ENV]: value }))
  }
})

test('дизайн-док фиксирует пакет, конфиг, таблицу, гибридный скор и критерии 016', () => {
  const doc = readFileSync(join(ROOT, 'docs/embeddings-design.md'), 'utf8')
  for (const needle of [
    'dsh-memory-embeddings',
    'enabled',
    'provider',
    'base_url',
    'model',
    'api_key_env',
    'CREATE TABLE embeddings',
    'BM25',
    'косинус',
    'DSH_MEMORY_NO_NETWORK',
    'doctor',
    'Критерии приёмки 016',
    'Открытые вопросы',
    'ANN',
  ]) {
    assert.ok(doc.includes(needle), `в дизайн-доке нет «${needle}»`)
  }
})
