/**
 * Бенчмарк на реальном корпусе проекта (задача 022): вопросы по README/AGENTS/
 * PLAN/спекам/карточкам, прогон на воркспейсе репозитория, отчёт
 * `docs/benchmark-real.md`, сравнение с фикстурой 015 и чистом unicode61,
 * понятные ошибки воркспейса/источников и независимость от `DSH_MEMORY_DB`.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BENCH_QUESTION_COUNT,
  BENCH_TARGETS,
  compareBenchmark,
  createBenchStore,
  loadBenchQuestions,
  runBenchmark,
} from '../lib/benchmark.js'
import { main } from '../lib/cli.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REAL_QUESTIONS = join(ROOT, 'bench/questions/real.json')

/** Прогнать бенчмарк на реальном корпусе в свежем временном хранилище. */
function realRun() {
  const bench = createBenchStore()
  try {
    return runBenchmark({ store: bench.store, workspace: ROOT, questions: loadBenchQuestions(REAL_QUESTIONS) })
  } finally {
    bench.dispose()
  }
}

test('20 вопросов по реальным документам: контракт и существующие источники', () => {
  const questions = loadBenchQuestions(REAL_QUESTIONS)
  assert.equal(questions.length, BENCH_QUESTION_COUNT)
  const sources = new Set(questions.map((question) => question.source))
  for (const source of ['README.md', 'AGENTS.md', 'PLAN.md', '.kanban/specs/001-mvp.md', '.kanban/tasks/020.md']) {
    assert.ok(sources.has(source), `нет вопроса по ${source}`)
  }
  for (const question of questions) {
    assert.ok(existsSync(join(ROOT, question.source)), `нет источника ${question.source}`)
  }
})

test('прогон на реальном корпусе: hit-rate и экономия достигают целей', () => {
  const result = realRun()
  assert.equal(result.questions, 20)
  assert.equal(result.perQuestion.length, 20)
  assert.ok(result.hitRate >= BENCH_TARGETS.hitRate, `hit-rate ${result.hitRate}`)
  assert.ok(result.tokenSavings >= BENCH_TARGETS.tokenSavings, `экономия ${result.tokenSavings}`)
  assert.ok(result.tokensBefore > result.tokensAfter)
  for (const item of result.perQuestion) {
    assert.equal(typeof item.relevant, 'boolean')
    assert.equal(item.relevant, item.matchedSources.includes(item.source), `${item.id}: relevant должен совпадать с наличием source в блоке`)
    for (const source of item.matchedSources) {
      assert.ok(existsSync(join(ROOT, source)), `${item.id}: блок ссылается на несуществующий ${source}`)
    }
  }
  const misses = result.perQuestion.filter((item) => !item.relevant)
  assert.equal(misses.length, result.questions - Math.round(result.hitRate * result.questions), 'промахи не должны скрываться')
  for (const miss of misses) assert.ok(miss.matchedSources.length > 0, `${miss.id}: у промаха нет альтернатив`)
})

test('лексический движок на реальном корпусе не хуже чистого unicode61', () => {
  const questions = loadBenchQuestions(REAL_QUESTIONS)
  const comparison = compareBenchmark({ workspace: ROOT, questions })
  assert.equal(comparison.lexical.questions, 20)
  assert.equal(comparison.unicode61.questions, 20)
  assert.ok(
    comparison.lexical.hitRate >= comparison.unicode61.hitRate,
    `lexical ${comparison.lexical.hitRate} < unicode61 ${comparison.unicode61.hitRate}`,
  )
})

test('CLI: отчёт на реальном корпусе воспроизводится побайтово и содержит промахи', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-real-'))
  try {
    const report = join(dir, 'benchmark-real.md')
    const io = { env: {}, stdout: { write: () => {} }, stderr: { write: () => {} } }
    const args = [
      'bench', '--workspace', ROOT, '--questions', REAL_QUESTIONS,
      '--compare', '--with-fixture', '--report', report, '--json',
    ]
    assert.equal(main(args, io), 0)
    const first = readFileSync(report, 'utf8')
    assert.match(first, /Бенчмарк dsh-memory на реальном корпусе/)
    assert.match(first, /Сравнение движков/)
    assert.match(first, /Сравнение с фикстурой 015/)
    assert.match(first, /## Промахи/)
    assert.match(first, /dsh-memory bench --workspace \. --questions bench\/questions\/real\.json --compare --with-fixture --report docs\/benchmark-real\.md/)

    assert.equal(main(args, io), 0)
    assert.equal(readFileSync(report, 'utf8'), first, 'отчёт должен быть воспроизводимым побайтово')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: несуществующий воркспейс — понятная ошибка, а не ENOENT', () => {
  const errors = []
  const missing = join(tmpdir(), 'dsh-memory-no-such-workspace-022')
  const code = main(['bench', '--workspace', missing], {
    env: {},
    stdout: { write: () => {} },
    stderr: { write: (chunk) => { errors.push(chunk) } },
  })
  assert.equal(code, 1)
  assert.match(errors.join(''), /воркспейс бенчмарка не найден/)
  assert.doesNotMatch(errors.join(''), /ENOENT/)
})

test('CLI: чужой корпус с отсутствующим источником вопроса — понятная ошибка', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-foreign-'))
  try {
    const qa = join(dir, 'questions.json')
    const questions = loadBenchQuestions(REAL_QUESTIONS).map((question) => ({ ...question, source: 'missing.md' }))
    writeFileSync(qa, JSON.stringify(questions))
    const errors = []
    const code = main(['bench', '--workspace', dir, '--questions', qa], {
      env: {},
      stdout: { write: () => {} },
      stderr: { write: (chunk) => { errors.push(chunk) } },
    })
    assert.equal(code, 1)
    assert.match(errors.join(''), /источник missing\.md не найден/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bench не зависит от DSH_MEMORY_DB: временная БД используется всегда', () => {
  const output = []
  const code = main(['bench', '--json'], {
    env: { DSH_MEMORY_DB: join(tmpdir(), 'dsh-memory-should-not-be-used-022') },
    stdout: { write: (chunk) => { output.push(chunk) } },
    stderr: { write: () => {} },
  })
  assert.equal(code, 0)
  const result = JSON.parse(output[0])
  assert.equal(result.questions, 20)
  assert.equal(result.passed, true)
})

test('index не принимает bench-флаги: код 2 и понятная ошибка', () => {
  for (const flag of [['--questions', 'x'], ['--with-fixture'], ['--compare']]) {
    const errors = []
    const code = main(['index', ...flag], {
      env: {},
      stdout: { write: () => {} },
      stderr: { write: (chunk) => { errors.push(chunk) } },
    })
    assert.equal(code, 2, `index ${flag.join(' ')} должен давать код 2`)
    assert.match(errors.join(''), /неизвестный аргумент/)
  }
})

test('--db-path вместе с --compare отклоняется с кодом 2', () => {
  const errors = []
  const code = main(['bench', '--compare', '--db-path', join(tmpdir(), 'dsh-memory-bench-db')], {
    env: {},
    stdout: { write: () => {} },
    stderr: { write: (chunk) => { errors.push(chunk) } },
  })
  assert.equal(code, 2)
  assert.match(errors.join(''), /--db-path несовместим с --compare/)
})
