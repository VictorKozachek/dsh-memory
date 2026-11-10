/**
 * Отчёт «FTS5 vs гибридный поиск» (задача 016).
 *
 * Одна команда: `node scripts/embeddings-benchmark.mjs --report docs/benchmark-embeddings.md`.
 * Гоняет 20 вопросов бенчмарка 015 на чистом FTS5 и на локальном гибридном
 * канале (хэшированные локальные эмбеддинги, без сети/ключей), пишет hit-rate,
 * экономию токенов и латентность. Латентность — единственная недетерминированная
 * часть отчёта; качество считается детерминированно.
 *
 * @module scripts/embeddings-benchmark
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import {
  BENCH_QUESTIONS_FILE,
  BENCH_WORKSPACE,
  createBenchStore,
  loadBenchQuestions,
  runBenchmark,
} from '../lib/benchmark.js'
import { indexWorkspace } from '../lib/indexer.js'
import { backfillEmbeddings } from '../packages/dsh-memory-embeddings/lib/backfill.js'
import { createLocalChannel } from '../packages/dsh-memory-embeddings/lib/channel.js'
import { createLocalProvider } from '../packages/dsh-memory-embeddings/lib/providers/local.js'

/** Разобрать аргументы. */
function parseArgs(argv) {
  const options = {
    workspace: BENCH_WORKSPACE,
    questions: BENCH_QUESTIONS_FILE,
    report: 'docs/benchmark-embeddings.md',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--workspace') options.workspace = resolve(argv[++index])
    else if (value === '--questions') options.questions = resolve(argv[++index])
    else if (value === '--report') options.report = resolve(argv[++index])
    else if (value === '--help' || value === '-h') {
      console.log('node scripts/embeddings-benchmark.mjs [--workspace <путь>] [--questions <файл>] [--report <файл>]')
      process.exit(0)
    } else {
      throw new Error(`неизвестный аргумент ${value}`)
    }
  }
  return options
}

/** Проценты. */
const percent = (value) => `${(value * 100).toFixed(1)}%`

/** Выполнить замер. */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  const questions = loadBenchQuestions(options.questions)
  const provider = createLocalProvider()

  const ftsBench = createBenchStore()
  const hybridBench = createBenchStore()
  try {
    const fts = runBenchmark({
      store: ftsBench.store,
      workspace: options.workspace,
      questions,
      measureLatency: true,
    })

    indexWorkspace({ workspace: options.workspace, store: hybridBench.store })
    const backfill = await backfillEmbeddings({ store: hybridBench.store, provider, model: provider.model })
    const channel = createLocalChannel({ store: hybridBench.store, provider, model: provider.model, weight: 0.5 })
    const hybrid = runBenchmark({
      store: hybridBench.store,
      workspace: options.workspace,
      questions,
      channels: [channel],
      measureLatency: true,
    })

    const report = renderReport({ fts, hybrid, backfill, workspace: options.workspace })
    mkdirSync(dirname(options.report), { recursive: true })
    writeFileSync(options.report, report, 'utf8')
    console.log(`FTS5: hit-rate ${percent(fts.hitRate)}, экономия ${percent(fts.tokenSavings)}, p95 ${fts.latencyMsP95.toFixed(2)} мс`)
    console.log(`hybrid: hit-rate ${percent(hybrid.hitRate)}, экономия ${percent(hybrid.tokenSavings)}, p95 ${hybrid.latencyMsP95.toFixed(2)} мс`)
    console.log(`отчёт: ${options.report}`)
  } finally {
    ftsBench.dispose()
    hybridBench.dispose()
  }
}

/** Markdown-отчёт. */
function renderReport({ fts, hybrid, backfill, workspace }) {
  const isFixture = resolve(workspace) === resolve(BENCH_WORKSPACE)
  return `# Бенчмарк эмбеддингов: FTS5 vs локальный гибрид

Сценарий: 20 вопросов бенчмарка 015 (${isFixture ? 'фикстурный мини-проект `bench/`' : 'реальный корпус проекта'});
память проиндексирована заранее. Векторы — локальный офлайн-провайдер
(\`local-hash-128\`: хэшированные слова/триграммы, без сети, ключей и модели),
бэкфилл ${backfill.embedded} записей. Гибрид — RRF по FTS5 и косинусу, вес 0.5.
Эмбеддинги по умолчанию выключены; отчёт показывает цену и качество опции.

| Метрика | FTS5 | FTS5 + локальные векторы |
|---|---|---|
| hit-rate | ${percent(fts.hitRate)} | ${percent(hybrid.hitRate)} |
| Токенов «до» | ${fts.tokensBefore} | ${hybrid.tokensBefore} |
| Токенов «после» | ${fts.tokensAfter} | ${hybrid.tokensAfter} |
| Экономия токенов | ${percent(fts.tokenSavings)} | ${percent(hybrid.tokenSavings)} |
| Латентность, средняя | ${fts.latencyMsAvg.toFixed(2)} мс | ${hybrid.latencyMsAvg.toFixed(2)} мс |
| Латентность, p95 | ${fts.latencyMsP95.toFixed(2)} мс | ${hybrid.latencyMsP95.toFixed(2)} мс |

## Вывод

Локальный хэшированный эмбеддер — не семантическая модель: он не даёт
прироста качества на смысловых промахах. На маленьком индексе латентность
гибрида в пределах шума, но brute-force косинус растёт линейно по числу
векторов; на большом корпусе нужен замер и, возможно, ANN. Это ожидаемо для
baseline и подтверждает решение: **дефолт — FTS5, эмбеддинги выключены**.
Реальный выигрыш должен дать нейросетевой локальный или API/Ollama провайдер
(у них теперь есть async-канал; в этом отчёте они не замерены: нужны модель
model_path/ключ, а отчёт воспроизводим офлайн). Открытые вопросы 021 — модель,
размерность, порог ANN; замер нейромодели — отдельный прогон на доступном
артефакте.

## Воспроизведение

\`\`\`bash
node scripts/embeddings-benchmark.mjs --report docs/benchmark-embeddings.md
\`\`\`

Латентность в отчёте измерена на конкретном прогоне и может отличаться;
hit-rate/токены детерминированы (без сети и текущей даты).
`
}

await main()
