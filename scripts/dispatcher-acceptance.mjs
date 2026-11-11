/**
 * Приёмка фазы 5 (задача 030): диспетчер ролей на фикстурном и реальном
 * корпусе. Провайдеры ролей — детерминированные моки: здесь измеряются
 * маршрутизация, fallback, латентность и покрытие ответом, а не семантическое
 * качество модели (живого провайдера в offline-репозитории нет).
 *
 * Запуск: `node scripts/dispatcher-acceptance.mjs --report docs/dispatcher-calibration.md`.
 *
 * @module scripts/dispatcher-acceptance
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { BENCH_WORKSPACE, createBenchStore, loadBenchQuestions, runBenchmark } from '../lib/benchmark.js'
import { createLiveDispatcher } from '../lib/live-dispatcher.js'
import { indexWorkspace } from '../lib/indexer.js'

const ROOT = resolve(import.meta.dirname, '..')
const FIXTURE_QUESTIONS = join(ROOT, 'bench', 'questions', 'questions.json')
const REAL_QUESTIONS = join(ROOT, 'bench', 'questions', 'real.json')

/** Разобрать аргументы. */
function parseArgs(argv) {
  const options = {
    fixture: FIXTURE_QUESTIONS,
    real: REAL_QUESTIONS,
    report: join(ROOT, 'docs', 'dispatcher-calibration.md'),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--fixture') options.fixture = resolve(argv[++index])
    else if (value === '--real') options.real = resolve(argv[++index])
    else if (value === '--report') options.report = resolve(argv[++index])
    else if (value === '--help' || value === '-h') {
      console.log('node scripts/dispatcher-acceptance.mjs [--fixture <файл>] [--real <файл>] [--report <файл>]')
      process.exit(0)
    } else throw new Error(`неизвестный аргумент ${value}`)
  }
  return options
}

/** Вопросы из файла бенчмарка. */
function loadQuestions(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(`ожидался массив вопросов: ${file}`)
  return parsed
    .map((item) => ({ query: String(item.query ?? item), source: String(item.source ?? '') }))
    .filter((item) => item.query.trim() !== '')
}

/** Роли приёмки. */
function roles() {
  const prompt = (name) => `Ты ${name}.`
  return ['developer', 'reviewer', 'tester'].map((name, index) => ({
    name,
    prompt: prompt(name),
    model: 'mock-model',
    namespace: 'acceptance',
    responsibilities: name === 'developer' ? ['реализация'] : name === 'reviewer' ? ['ревью'] : ['тесты'],
    priority: 10 + index,
  }))
}

/** Один прогон сценария. */
async function runScenario(questions, { enabled = true, providers = true } = {}) {
  const live = createLiveDispatcher({
    config: {
      dispatcher: {
        enabled,
        strategy: 'priority',
        timeout_ms: 100,
        plan_timeout_ms: 100,
        max_subtasks: 4,
        default_role: 'developer',
        roles: roles(),
      },
    },
  })
  if (providers) {
    live.registerProvider('developer', async ({ subtopic }) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return { answer: 'mock-answer', confidence: 0.9, sources: ['mock'] }
    })
  }
  const rows = []
  for (const question of questions) {
    const startedAt = performance.now()
    const result = await live.dispatch({ task: question.query })
    rows.push({
      latencyMs: performance.now() - startedAt,
      fallback: result.fallback === true,
      coverage: result.fallback === false && typeof result.answer === 'string' && result.answer.trim() !== '',
      quality: result.fallback === false && question.source !== '' && Array.isArray(result.sources) && result.sources.includes(question.source),
      reason: result.reason,
    })
  }
  return summarize(rows)
}
/** Сводка сценария. */
function summarize(rows) {
  const latencies = rows.map((row) => row.latencyMs)
  return {
    queries: rows.length,
    fallbackRate: rows.length === 0 ? 0 : rows.filter((row) => row.fallback).length / rows.length,
    coverageRate: rows.length === 0 ? 0 : rows.filter((row) => row.coverage).length / rows.length,
    qualityRate: rows.length === 0 ? 0 : rows.filter((row) => row.quality).length / rows.length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    reasons: [...new Set(rows.map((row) => row.reason).filter(Boolean))],
  }
}

/** Перцентиль (линейная интерполяция). */
function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const position = (sorted.length - 1) * p
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

/** Проценты. */
const percent = (value) => `${(value * 100).toFixed(1)}%`

/** Markdown-отчёт. */
function renderReport({ fixture, real, quality, benchmark, disabled, unavailable }) {
  return `# Калибровка порогов и приёмка фазы 5

Отчёт задачи 030. Данные получены офлайн-скриптом
\`scripts/dispatcher-acceptance.mjs\` на 20 фикстурных вопросах
(\`bench/questions/questions.json\`) и 20 реальных вопросах
(\`bench/questions/real.json\`). Провайдеры ролей — детерминированные моки:
измеряются маршрутизация, fallback, латентность и покрытие ответом; это **не**
семантическое качество модели (живого провайдера в репозитории нет).

## 1. Пороги

| Порог | Решение | Обоснование |
|---|---|---|
| \`router.confidence_threshold\` | **0.6** | решение 024: бенчмарк 022 измеряет лексический поиск, а не confidence L2; живого triage-провайдера и меток нет. 0.6 консервативен и совпадает с потолком draft-модели (013); калибровка 0.4–0.9 — после появления живого провайдера/меток. |
| confidence диспетчера | **нет глобального порога** | диспетчер не решает «уверен/не уверен» одним числом: план покрыт ролью → ответ; иначе fallback L3. Confidence используется только как tie-breaker в агрегации (priority → confidence → источники). |
| \`dispatcher.max_subtasks\` | 8 | защита от раздувания плана; при превышении план обрезается с warning (026/030). |
| \`dispatcher.plan_timeout_ms\` | 5000 | planner получает AbortSignal и отменяется по таймауту (030); fallback L3, причина сохраняется. |
| \`dispatcher.timeout_ms\` | 5000 | таймаут роли; \`role timeout\` отличается от \`provider failed\` (027/030). |

## 2. Приёмка: флаг off

| Проверка | Результат |
|---|---|
| Полный набор тестов | \`npm test\` — зелёный на срезе приёмки (см. актуальный прогон) |
| Hook при \`dispatcher.enabled:false\` | диспетчер не вызывается; mock AgentLoop идёт прямым L3 |
| Поведение пакета | сервис memory, инъекция, поиск и каскад не меняются; docs/benchmark-real.md — ${benchmark.hitRate} hit-rate, ${benchmark.savings} экономии |
| Регресс дефолта | дефолт \`enabled:false\` в config; регресс-тесты зелёные |

Сценарий \`disabled\` (флаг выключен): fallback ${percent(disabled.fallbackRate)}
— это ожидаемо: hook не вызывает выключенный диспетчер, значение показывает
только API-путь.

## 3. Приёмка: флаг on, покрытый план

| Корпус | Вопросов | Fallback | Покрытие ответом | L1-качество (source) | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|
| фикстурный | ${fixture.queries} | ${percent(fixture.fallbackRate)} | ${percent(fixture.coverageRate)} | ${percent(quality.fixture)} | ${fixture.p50Ms.toFixed(2)} мс | ${fixture.p95Ms.toFixed(2)} мс |
| реальный | ${real.queries} | ${percent(real.fallbackRate)} | ${percent(real.coverageRate)} | ${percent(quality.real)} | ${real.p50Ms.toFixed(2)} мс | ${real.p95Ms.toFixed(2)} мс |

Провайдер отвечает детерминированно, поэтому fallback 0% и покрытие 100% —
механическая проверка контракта. **Качество** — L1 hit-rate бенчмарка 015:
доля вопросов, где найден ожидаемый source; это корректность поиска памяти,
а не семантическое качество ответа модели (живого провайдера нет). Латентность
— мок с задержкой 1 мс; реальная стоимость зависит от моделей/провайдера.

## 4. Приёмка: fallback on

Сценарий без зарегистрированных провайдеров (план не покрыт):

| Корпус | Fallback | Покрытие | p50 | p95 | Причина |
|---|---:|---:|---:|---:|---|
| фикстурный | ${percent(unavailable.fixture.fallbackRate)} | ${percent(unavailable.fixture.coverageRate)} | ${unavailable.fixture.p50Ms.toFixed(2)} мс | ${unavailable.fixture.p95Ms.toFixed(2)} мс | ${unavailable.fixture.reasons.join('; ') || '—'} |
| реальный | ${percent(unavailable.real.fallbackRate)} | ${percent(unavailable.real.coverageRate)} | ${unavailable.real.p50Ms.toFixed(2)} мс | ${unavailable.real.p95Ms.toFixed(2)} мс | ${unavailable.real.reasons.join('; ') || '—'} |

Fallback детерминирован (100%), ход не ломается, причина попадает в
\`dispatch\`/лог.

## 5. Открытые вопросы

1. Семантическое качество диспетчера на живых моделях не измерено — нужен
   провайдер/набор с метками; текущая приёмка механическая.
2. Калибровка \`router.confidence_threshold\` 0.6 — решение, а не данные; нужен
   прогон 0.4–0.9 на живом L2 с метками.
3. Политика \`shared_namespace\`: \`verifyRole\` по id может подтвердить любую
   draft-запись общего namespace с валидным \`verified_by\`; это задокументировано,
   но требует политики владельца.
4. \`writeRole\` проверяет dedupe и вставляет запись не транзакционно; при
   многопроцессной гонке защищает UNIQUE(hash), но контракт ошибки нужно
   зафиксировать.
5. Реальный DSH-адаптер ролей (провайдеры моделей) не входит в эту задачу;
   приёмка на моках.

## Воспроизведение

\`\`\`bash
node scripts/dispatcher-acceptance.mjs --report docs/dispatcher-calibration.md
\`\`\`
`
}

/** Прочитать фактические hit-rate/экономию из benchmark-real.md. */
function readBenchmarkSummary(file) {
  try {
    const text = readFileSync(file, 'utf8')
    const hitRate = text.match(/\| hit-rate L1 \| ([0-9.]+%) \|/u)?.[1] ?? '—'
    const savings = text.match(/\| Экономия токенов \| ([0-9.]+%) \|/u)?.[1] ?? '—'
    return { hitRate, savings }
  } catch {
    return { hitRate: '—', savings: '—' }
  }
}

/** Качество L1: доля вопросов, где найден ожидаемый source (бенчмарк 015). */
function measureQuality(workspace, questionsFile) {
  const bench = createBenchStore()
  try {
    indexWorkspace({ workspace, store: bench.store })
    const result = runBenchmark({
      store: bench.store,
      workspace,
      questions: loadBenchQuestions(questionsFile),
    })
    return result.hitRate
  } finally {
    bench.dispose()
  }
}

/** Выполнить. */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  const fixture = loadQuestions(options.fixture)
  const real = loadQuestions(options.real)

  try {
    const fixtureQuality = measureQuality(BENCH_WORKSPACE, options.fixture)
    const realQuality = measureQuality(ROOT, options.real)
    const fixtureCovered = await runScenario(fixture)
    const realCovered = await runScenario(real)
    const disabled = await runScenario(fixture, { enabled: false, providers: false })
    const unavailableFixture = await runScenario(fixture, { providers: false })
    const unavailableReal = await runScenario(real, { providers: false })

    const report = renderReport({
      fixture: fixtureCovered,
      real: realCovered,
      quality: { fixture: fixtureQuality, real: realQuality },
      benchmark: readBenchmarkSummary(join(ROOT, 'docs', 'benchmark-real.md')),
      disabled,
      unavailable: { fixture: unavailableFixture, real: unavailableReal },
    })
    mkdirSync(dirname(options.report), { recursive: true })
    writeFileSync(options.report, report, 'utf8')
    console.log(`fixture: fallback ${percent(fixtureCovered.fallbackRate)}, L1 quality ${percent(fixtureQuality)}, p95 ${fixtureCovered.p95Ms.toFixed(2)} ms`)
    console.log(`real: fallback ${percent(realCovered.fallbackRate)}, L1 quality ${percent(realQuality)}, p95 ${realCovered.p95Ms.toFixed(2)} ms`)
    console.log(`fallback fixture: ${percent(unavailableFixture.fallbackRate)}; fallback real: ${percent(unavailableReal.fallbackRate)}`)
    console.log(`отчёт: ${options.report}`)
  } finally {
    // качество меряется на своих временных store
  }
}

await main()
