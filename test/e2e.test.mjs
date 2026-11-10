/**
 * Приёмка фазы 0 (задача 009): CLI `index` строит индекс по фикстурам
 * документации, `memory.search` находит все три известных определения,
 * повторная индексация идемпотентна, метрики и статистика работают на живом
 * индексе.
 *
 * Фикстуры — `test/fixtures/phase0/`: три определения, повторяющие смысл
 * README/PLAN (память проекта, каскад L0 → L1 → L2 → L3, верификация).
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { main } from '../lib/cli.js'
import { memoryStats } from '../lib/metrics.js'
import { searchMemory } from '../lib/search.js'
import { openStore } from '../lib/store.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = join(ROOT, 'test/fixtures/phase0')

/** Три определения из документации проекта: чем ищем и откуда они. */
const DEFINITIONS = [
  { query: 'долговременное хранилище знаний', source: 'docs/memory.md' },
  { query: 'порядок поиска ответа', source: 'docs/cascade.md' },
  { query: 'подтверждение записи ревьювером', source: 'docs/verification.md' },
]

/** Прогнать CLI `dsh-memory index` по фикстурам и вернуть отчёт. */
function runIndex(dbDir, namespace = 'phase0') {
  let output = ''
  const code = main(['index', '--workspace', FIXTURES, '--db-path', dbDir, '--namespace', namespace, '--json'], {
    env: {},
    stdout: { write: (chunk) => { output += chunk } },
    stderr: { write: () => {} },
  })
  return { code, summary: output === '' ? null : JSON.parse(output) }
}

test('e2e фазы 0: CLI index строит индекс, memory.search находит три определения', (t) => {
  const dbDir = mkdtempSync(join(tmpdir(), 'dsh-memory-e2e-'))
  t.after(() => rmSync(dbDir, { recursive: true, force: true }))

  const { code, summary } = runIndex(dbDir)
  assert.equal(code, 0)
  assert.equal(summary.namespace, 'phase0')
  assert.equal(summary.files, 3)
  assert.equal(summary.indexed, 3)
  assert.ok(summary.chunks >= 3, `чанков слишком мало: ${summary.chunks}`)
  assert.deepEqual(summary.secrets, [])
  assert.deepEqual(summary.failed, [])

  const store = openStore({ dbPath: dbDir, namespace: 'phase0' })
  t.after(() => store.close())

  for (const { query, source } of DEFINITIONS) {
    const results = searchMemory(store, { query })
    assert.ok(results.length > 0, `по запросу "${query}" ничего не найдено`)
    const found = results.find((result) => result.source_path === source)
    assert.ok(found, `определение из ${source} не найдено по запросу "${query}"`)
    assert.equal(found.status, 'verified', 'документ из индексатора должен быть verified')
    assert.ok(found.snippet.length <= 300, 'сниппет длиннее 300 символов')
  }

  // События search записались, статистика посчиталась на живом индексе.
  // Семантика 011: L1-поиск/инъекция — расход, а не экономия; savings в MVP
  // остаются 0 до калибровки L2↔L3 (012/015).
  const stats = memoryStats(store)
  assert.ok(stats.entries >= summary.chunks)
  assert.ok(stats.by_status.verified >= summary.chunks)
  assert.ok(stats.hit_rate > 0, 'hit_rate должен быть больше нуля после успешных поисков')
  assert.equal(stats.tokens_saved_estimate, 0, 'L1-поиск не формирует savings')
})

test('e2e фазы 0: повторный index не переиндексирует неизменённые файлы', (t) => {
  const dbDir = mkdtempSync(join(tmpdir(), 'dsh-memory-e2e-'))
  t.after(() => rmSync(dbDir, { recursive: true, force: true }))

  const first = runIndex(dbDir)
  assert.equal(first.summary.indexed, 3)

  const second = runIndex(dbDir)
  assert.equal(second.code, 0)
  assert.equal(second.summary.files, 3)
  assert.equal(second.summary.indexed, 0)
  assert.equal(second.summary.unchanged, 3)
  assert.equal(second.summary.chunks, 0)
  assert.deepEqual(second.summary.secrets, [])
})
