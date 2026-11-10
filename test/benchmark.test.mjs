/**
 * Тесты бенчмарка MVP (задача 015): 20 повторяющихся вопросов, замер
 * токенов до/после, hit-rate, цели (≥ 20% hit-rate, ≥ 25% экономии),
 * воспроизводимость и команда `dsh-memory bench`.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BENCH_QUESTION_COUNT,
  compareBenchmark,
  BENCH_QUESTIONS_FILE,
  BENCH_TARGETS,
  BENCH_WORKSPACE,
  createBenchStore,
  loadBenchQuestions,
  renderBenchmarkReport,
  runBenchmark,
  writeBenchmarkReport,
} from '../lib/benchmark.js'
import { main } from '../lib/cli.js'
import { buildMemoryBlock } from '../lib/inject.js'
import { indexWorkspace } from '../lib/indexer.js'
import { openStore } from '../lib/store.js'

/** Запустить бенчмарк на свежем временном хранилище. */
function benchOnce() {
  const bench = createBenchStore()
  try {
    return runBenchmark({ store: bench.store })
  } finally {
    bench.dispose()
  }
}

test('вопросы бенчмарка: ровно 20, контракт и существующие источники', () => {
  const questions = loadBenchQuestions()
  assert.equal(questions.length, BENCH_QUESTION_COUNT)
  assert.equal(new Set(questions.map((question) => question.id)).size, questions.length)
  for (const question of questions) {
    assert.equal(typeof question.query, 'string')
    assert.ok(question.query.trim() !== '')
    assert.ok(existsSync(join(BENCH_WORKSPACE, question.source)), `нет источника ${question.source}`)
  }
  assert.equal(JSON.parse(readFileSync(BENCH_QUESTIONS_FILE, 'utf8')).length, 20)
})

test('бенчмарк достигает целей MVP и считает экономию на 20 вопросах', () => {
  const result = benchOnce()
  assert.equal(result.questions, 20)
  assert.ok(result.hitRate >= BENCH_TARGETS.hitRate, `hit-rate ${result.hitRate}`)
  assert.ok(result.tokenSavings >= BENCH_TARGETS.tokenSavings, `экономия ${result.tokenSavings}`)
  assert.ok(result.tokensBefore > result.tokensAfter)
  assert.equal(result.targets.hitRate, true)
  assert.equal(result.targets.tokenSavings, true)
  assert.equal(result.passed, true)

  assert.equal(result.perQuestion.length, 20)
  for (const item of result.perQuestion) {
    assert.ok(item.relevant, `${item.id} без релевантного попадания: ${item.matchedSources.join(', ')}`)
    assert.ok(item.matchedSources.includes(item.source), `${item.id}: нет источника ${item.source}`)
    assert.ok(item.before > item.after, `${item.id}: экономии нет (${item.before} → ${item.after})`)
  }
})

test('бенчмарк воспроизводим: два прогона дают одинаковые числа', () => {
  const first = benchOnce()
  const second = benchOnce()
  assert.deepEqual(second, first)
})

test('отчёт: markdown с целями, 20 вопросами и воспроизведением', () => {
  const result = benchOnce()
  const report = renderBenchmarkReport(result)
  assert.match(report, /# Бенчмарк MVP dsh-memory/)
  assert.match(report, /hit-rate L1/)
  assert.match(report, /Экономия токенов/)
  assert.match(report, /dsh-memory bench (?:--compare )?--report docs\/benchmark-mvp\.md/)
  assert.equal((report.match(/^\| \d+ \|/gmu) ?? []).length, 20)
  assert.match(report, /свойство подобранной фикстуры/)
  assert.match(report, /задача 022/)

  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-report-'))
  try {
    const file = join(dir, 'docs/benchmark-mvp.md')
    writeBenchmarkReport(file, report)
    assert.equal(readFileSync(file, 'utf8'), report)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI bench: --json и --report, код 0 при достигнутых целях', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-bench-cli-'))
  try {
    const output = []
    const errors = []
    const io = {
      env: {},
      stdout: { write: (chunk) => { output.push(chunk) } },
      stderr: { write: (chunk) => { errors.push(chunk) } },
    }
    const report = join(dir, 'benchmark.md')
    const code = main(['bench', '--json', '--report', report], io)
    assert.equal(code, 0, errors.join(''))
    const result = JSON.parse(output[0])
    assert.equal(result.questions, 20)
    assert.equal(result.passed, true)
    assert.ok(existsSync(report))
    assert.match(readFileSync(report, 'utf8'), /Экономия токенов/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI bench: help и неизвестный аргумент', () => {
  const help = { env: {}, stdout: { write: () => {} }, stderr: { write: () => {} } }
  assert.equal(main(['bench', '--help'], help), 0)
  const errors = []
  const code = main(['bench', '--nope'], { env: {}, stdout: { write: () => {} }, stderr: { write: (chunk) => { errors.push(chunk) } } })
  assert.equal(code, 2)
  assert.match(errors.join(''), /неизвестный аргумент/)
})

test('край конфига: сниппет 2000 символов не влезает в бюджет 600 — блок пустой, а не сверх лимита', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-budget-'))
  const store = openStore({ dbPath: dir, namespace: 'demo' })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  store.insertEntry({
    kind: 'fact',
    title: 'Длинная запись',
    text: `длинная запись ${'слово '.repeat(600)}`,
    status: 'verified',
    confidence: 1,
  })

  const result = buildMemoryBlock(store, 'длинная запись', { snippetChars: 2000, tokenBudget: 600, env: {} })
  assert.equal(result.block, null, 'строка не влезла в бюджет — блок должен быть пустым')
  assert.equal(result.tokens, 0)
  assert.ok(result.hits > 0, 'поиск находит запись, просто она не помещается в бюджет')
})

test('отчёт сравнения воспроизводится командой с --compare', () => {
  const comparison = compareBenchmark()
  const report = renderBenchmarkReport({ ...comparison.lexical, comparison: comparison.unicode61 })
  assert.match(report, /dsh-memory bench --compare --report docs\/benchmark-mvp\.md/)
  assert.match(report, /Сравнение движков/)
  assert.match(report, /unicode61 \(чистый\)/)
  assert.match(report, /цели достигнуты на фикстуре/)
})
