/**
 * CLI `dsh-memory` (задачи 003, 015): `index` и `bench`.
 *
 *   dsh-memory index --workspace <путь> [--db-path <каталог>] [--namespace <имя>] [--json]
 *   dsh-memory bench [--workspace <путь>] [--questions <файл>] [--db-path <каталог>] [--namespace <имя>] [--report <файл>] [--compare] [--with-fixture] [--json]
 *
 * `bench` гоняет 20 вопросов бенчмарка MVP по фикстурам пакета (`bench/`),
 * печатает hit-rate/экономию токенов и пишет markdown-отчёт (`--report`).
 *
 * Путь к БД берётся из `--db-path` или `DSH_MEMORY_DB`, по умолчанию
 * `~/.dsh/memory`; namespace — из `--namespace` или имя каталога воркспейса.
 * Печать — человекочитаемая или JSON (`--json`) для тестов и агентов.
 *
 * @module dsh-memory/cli
 */

import { basename, resolve } from 'node:path'

import {
  BENCH_QUESTIONS_FILE,
  BENCH_WORKSPACE,
  createBenchStore,
  compareBenchmark,
  loadBenchQuestions,
  renderBenchmarkReport,
  runBenchmark,
  writeBenchmarkReport,
} from './benchmark.js'
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE, DEFAULT_MAX_CHUNK_TOKENS, indexWorkspace } from './indexer.js'
import { openStore } from './store.js'

const USAGE = `dsh-memory — долгосрочная память проекта для DSH

Использование:
  dsh-memory index --workspace <путь> [--db-path <каталог>] [--namespace <имя>] [--json]
  dsh-memory bench [--workspace <путь>] [--questions <файл>] [--db-path <каталог>] [--namespace <имя>] [--report <файл>] [--compare] [--with-fixture] [--json]

Команда index обходит markdown-файлы воркспейса (${DEFAULT_INCLUDE.join(', ')}
минус ${DEFAULT_EXCLUDE.join(', ')}), режет их по заголовкам ## на чанки
не длиннее ${DEFAULT_MAX_CHUNK_TOKENS} токенов (оценка) и пишет в SQLite-память.
Секреты (*.env, *secret*, *credential*, ключи) не индексируются.

Команда bench прогоняет 20 вопросов бенчмарка MVP по фикстурам пакета
(bench/questions/questions.json) и печатает hit-rate и экономию токенов; с
--report пишет markdown-отчёт (например, docs/benchmark-mvp.md). Воркспейс по
умолчанию — встроенные фикстуры; --db-path задаёт постоянную БД вместо
временной. --questions задаёт файл вопросов (например, bench/questions/real.json
для реального корпуса), --compare прогоняет сценарий на лексическом движке
(Snowball + триграммы + синонимы) и на чистом unicode61, --with-fixture
добавляет к сравнению фикстурный прогон 015. Временная БД используется всегда,
если не задан --db-path; DSH_MEMORY_DB на bench не влияет.

Окружение:
  DSH_MEMORY_DB   каталог файлов БД (по умолчанию ~/.dsh/memory)
`

/** Ошибка разбора аргументов: печатается без стека и даёт код 2. */
class UsageError extends Error {}

/**
 * Точка входа CLI. Синхронная: хранилище и индексатор синхронные.
 *
 * @param {string[]} [argv] — аргументы без `node` и имени скрипта.
 * @param {{ env?: Record<string, string | undefined>, stdout?: { write(chunk: string): unknown }, stderr?: { write(chunk: string): unknown } }} [io] — потоки и окружение для тестов.
 * @returns {number} код возврата: 0 — успех, 1 — ошибка индексации, 2 — аргументы.
 */
export function main(argv = [], { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const [command, ...args] = argv

  if (command === undefined) {
    stderr.write(`${USAGE}\n`)
    return 2
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    stdout.write(`${USAGE}\n`)
    return 0
  }
  if (command === 'bench') return runBenchCommand(args, { env, stdout, stderr })
  if (command !== 'index') {
    stderr.write(`dsh-memory: неизвестная команда "${command}"\n\n${USAGE}\n`)
    return 2
  }

  let options
  try {
    options = parseIndexArgs(args, env)
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`dsh-memory: ${error.message}\n\n${USAGE}\n`)
      return 2
    }
    throw error
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`)
    return 0
  }

  const workspace = resolve(options.workspace)
  const namespace = options.namespace ?? namespaceFor(workspace)
  let store
  try {
    store = openStore({ dbPath: options.dbPath, namespace })
    const summary = indexWorkspace({ workspace, store, maxChunkTokens: options.maxChunkTokens })
    stdout.write(`${options.json ? JSON.stringify(summary, null, 2) : renderSummary(summary)}\n`)
    return 0
  } catch (error) {
    stderr.write(`dsh-memory: индексация не удалась: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  } finally {
    store?.close()
  }
}

/**
 * Разобрать аргументы команды `index`.
 *
 * @param {string[]} argv — аргументы после `index`.
 * @param {Record<string, string | undefined>} env — окружение.
 * @returns {{ workspace: string, dbPath: string, namespace?: string, maxChunkTokens: number, json: boolean, help: boolean }} разобранные опции.
 */
function parseIndexArgs(argv, env) {
  const options = {
    workspace: process.cwd(),
    dbPath: env.DSH_MEMORY_DB?.trim() || '~/.dsh/memory',
    namespace: undefined,
    maxChunkTokens: DEFAULT_MAX_CHUNK_TOKENS,
    json: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') {
      options.json = true
    } else if (argument === '--help' || argument === '-h') {
      options.help = true
    } else if (argument === '--workspace') {
      options.workspace = takeValue(argv, ++index, '--workspace')
    } else if (argument.startsWith('--workspace=')) {
      options.workspace = requireValue(argument.slice('--workspace='.length), '--workspace')
    } else if (argument === '--db-path') {
      options.dbPath = takeValue(argv, ++index, '--db-path')
    } else if (argument.startsWith('--db-path=')) {
      options.dbPath = requireValue(argument.slice('--db-path='.length), '--db-path')
    } else if (argument === '--namespace') {
      options.namespace = takeValue(argv, ++index, '--namespace')
    } else if (argument.startsWith('--namespace=')) {
      options.namespace = requireValue(argument.slice('--namespace='.length), '--namespace')
    } else if (argument === '--max-chunk-tokens') {
      options.maxChunkTokens = parsePositiveInt(takeValue(argv, ++index, '--max-chunk-tokens'))
    } else if (argument.startsWith('--max-chunk-tokens=')) {
      options.maxChunkTokens = parsePositiveInt(requireValue(argument.slice('--max-chunk-tokens='.length), '--max-chunk-tokens'))
    } else {
      throw new UsageError(`неизвестный аргумент "${argument}"`)
    }
  }

  return options
}

/**
 * Взять значение следующего аргумента.
 *
 * @param {string[]} argv — аргументы.
 * @param {number} index — индекс значения.
 * @param {string} flag — имя флага для ошибки.
 * @returns {string} значение.
 */
function takeValue(argv, index, flag) {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`флаг ${flag} требует значение`)
  }
  return value
}

/**
 * Проверить, что значение непустое.
 *
 * @param {string} value — значение.
 * @param {string} flag — имя флага для ошибки.
 * @returns {string} значение.
 */
function requireValue(value, flag) {
  if (value.trim() === '') throw new UsageError(`флаг ${flag} требует значение`)
  return value
}

/**
 * Разобрать положительное целое из аргумента.
 *
 * @param {string} value — строка.
 * @returns {number} число.
 */
function parsePositiveInt(value) {
  if (!/^\d+$/.test(value.trim()) || Number(value) < 1) {
    throw new UsageError(`ожидалось целое ≥ 1, получено "${value}"`)
  }
  return Number(value)
}

/**
 * Namespace по умолчанию — имя каталога воркспейса.
 *
 * @param {string} workspace — абсолютный путь воркспейса.
 * @returns {string} namespace.
 */
function namespaceFor(workspace) {
  return basename(workspace) || 'default'
}

/**
 * Человекочитаемый отчёт об индексации.
 *
 * @param {ReturnType<typeof indexWorkspace>} summary — отчёт.
 * @returns {string} текст для stdout.
 */
function renderSummary(summary) {
  const lines = [
    `воркспейс: ${summary.workspace}`,
    `namespace: ${summary.namespace}`,
    `файлов: ${summary.files}; проиндексировано: ${summary.indexed}; без изменений: ${summary.unchanged}`,
    `чанков: ${summary.chunks}${summary.deduped > 0 ? `; дубликатов по hash: ${summary.deduped}` : ''}`,
  ]
  if (summary.skipped > 0) {
    lines.push(`секретов пропущено: ${summary.skipped}: ${summary.secrets.join(', ')}`)
  }
  if (summary.failed.length > 0) {
    lines.push(`ошибок чтения: ${summary.failed.length}: ${summary.failed.map((item) => item.path).join(', ')}`)
  }
  return lines.join('\n')
}


/**
 * Команда `bench`: прогнать бенчмарк MVP и напечатать/записать отчёт.
 *
 * @param {string[]} argv — аргументы после `bench`.
 * @param {{ env: Record<string, string | undefined>, stdout: { write(chunk: string): unknown }, stderr: { write(chunk: string): unknown } }} io — потоки и окружение.
 * @returns {number} код возврата: 0 — цели достигнуты, 1 — нет/ошибка, 2 — аргументы.
 */
function runBenchCommand(argv, { env, stdout, stderr }) {
  let options
  try {
    options = parseBenchArgs(argv, env)
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`dsh-memory: ${error.message}\n\n${USAGE}\n`)
      return 2
    }
    throw error
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`)
    return 0
  }
  if (options.compare && options.dbPath !== undefined) {
    stderr.write('dsh-memory: --db-path несовместим с --compare: сравнение всегда идёт на временных БД\n\n')
    return 2
  }

  const workspace = options.workspace === undefined ? BENCH_WORKSPACE : resolve(options.workspace)
  const reportPath = options.report === undefined ? undefined : resolve(options.report)
  const questionsFile = options.questions === undefined ? BENCH_QUESTIONS_FILE : resolve(options.questions)
  let store
  let bench
  try {
    const questions = loadBenchQuestions(questionsFile)
    let result
    if (options.compare) {
      const comparison = compareBenchmark({ workspace, questions })
      result = comparisonResult(comparison)
      if (options.withFixture) {
        const fixtureBench = createBenchStore()
        try {
          result.fixture = runBenchmark({ store: fixtureBench.store, workspace: BENCH_WORKSPACE, questions: loadBenchQuestions() })
        } finally {
          fixtureBench.dispose()
        }
      }
    } else {
      if (options.dbPath === undefined) {
        bench = createBenchStore({ namespace: options.namespace ?? 'benchmark' })
        store = bench.store
      } else {
        store = openStore({ dbPath: options.dbPath, namespace: options.namespace ?? 'benchmark' })
      }
      result = runBenchmark({ store, workspace, questions })
    }
    if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      stdout.write(`${renderBenchSummary(result)}\n`)
    }
    if (reportPath !== undefined) {
      writeBenchmarkReport(reportPath, renderBenchmarkReport(result))
      stdout.write(`отчёт: ${reportPath}\n`)
    }
    return result.passed ? 0 : 1
  } catch (error) {
    stderr.write(`dsh-memory: бенчмарк не удался: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  } finally {
    if (bench !== undefined) bench.dispose()
    else store?.close()
  }
}

/**
 * Разобрать аргументы команды `bench`.
 *
 * @param {string[]} argv — аргументы после `bench`.
 * @param {Record<string, string | undefined>} env — окружение.
 * @returns {{ workspace?: string, dbPath?: string, namespace?: string, report?: string, json: boolean, help: boolean }} опции.
 */
function parseBenchArgs(argv, env) {
  const options = {
    workspace: undefined,
    dbPath: undefined,
    namespace: undefined,
    questions: undefined,
    report: undefined,
    json: false,
    compare: false,
    withFixture: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') {
      options.json = true
    } else if (argument === '--compare') {
      options.compare = true
    } else if (argument === '--with-fixture') {
      options.withFixture = true
    } else if (argument === '--help' || argument === '-h') {
      options.help = true
    } else if (argument === '--workspace') {
      options.workspace = takeValue(argv, ++index, '--workspace')
    } else if (argument.startsWith('--workspace=')) {
      options.workspace = requireValue(argument.slice('--workspace='.length), '--workspace')
    } else if (argument === '--questions') {
      options.questions = takeValue(argv, ++index, '--questions')
    } else if (argument.startsWith('--questions=')) {
      options.questions = requireValue(argument.slice('--questions='.length), '--questions')
    } else if (argument === '--db-path') {
      options.dbPath = takeValue(argv, ++index, '--db-path')
    } else if (argument.startsWith('--db-path=')) {
      options.dbPath = requireValue(argument.slice('--db-path='.length), '--db-path')
    } else if (argument === '--namespace') {
      options.namespace = takeValue(argv, ++index, '--namespace')
    } else if (argument.startsWith('--namespace=')) {
      options.namespace = requireValue(argument.slice('--namespace='.length), '--namespace')
    } else if (argument === '--report') {
      options.report = takeValue(argv, ++index, '--report')
    } else if (argument.startsWith('--report=')) {
      options.report = requireValue(argument.slice('--report='.length), '--report')
    } else {
      throw new UsageError(`неизвестный аргумент "${argument}"`)
    }
  }

  return options
}

/**
 * Человекочитаемый отчёт бенчмарка.
 *
 * @param {ReturnType<typeof runBenchmark>} result — результат.
 * @returns {string} текст для stdout.
 */
function renderBenchSummary(result) {
  const percent = (value) => `${(value * 100).toFixed(1)}%`
  const lines = [
    `воркспейс: ${result.workspace}`,
    `вопросов: ${result.questions}; hit-rate: ${percent(result.hitRate)} (цель ≥ 20%)`,
    `токенов до: ${result.tokensBefore}; после: ${result.tokensAfter}; экономия: ${percent(result.tokenSavings)} (цель ≥ 25%)`,
    `итог: ${result.passed ? 'цели достигнуты' : 'цели НЕ достигнуты'}`,
  ]
  if (result.comparison !== undefined) {
    const raw = result.comparison
    lines.push(
      `сравнение с unicode61: hit-rate ${percent(raw.hitRate)}; экономия ${percent(raw.tokenSavings)}; токенов после ${raw.tokensAfter}`,
    )
  }
  const misses = result.perQuestion.filter((item) => !item.relevant)
  if (misses.length > 0) {
    lines.push(`нералевантных попаданий: ${misses.length}: ${misses.map((item) => item.id).join(', ')}`)
  }
  return lines.join('\n')
}

/**
 * Свернуть результат сравнения движков в форму одного отчёта: поля
 * лексического движка плюс `comparison` (unicode61).
 *
 * @param {{ lexical: Record<string, unknown>, unicode61: Record<string, unknown> }} comparison — результаты.
 * @returns {Record<string, unknown>} отчёт с `comparison`.
 */
function comparisonResult(comparison) {
  return { ...comparison.lexical, comparison: comparison.unicode61 }
}
