/**
 * Бенчмарк MVP (задача 015): 20 повторяющихся вопросов по проекту, замер
 * токенов «до/после» памяти и hit-rate.
 *
 * «До» — сколько токенов модель прочитала бы без памяти: полный текст
 * источника ответа (`estimateTokens` файла). «После» — сколько токенов памяти
 * добавляет инъекция L1 (`buildMemoryBlock`: top-k сниппетов, бюджет 600) плюс
 * полный текст источника, если память не дала релевантного попадания. Задача
 * считает попадание релевантным только если в блоке есть ожидаемый
 * `source_path`: `matchMode: any` может подмешать запись по общему слову, и
 * бенчмарк не должен считать это экономией.
 *
 * Фикстуры (`bench/fixtures/project`) и вопросы (`bench/questions`) лежат в
 * пакете, поэтому прогон воспроизводим: `dsh-memory bench`. Цели MVP:
 * hit-rate ≥ 20%, экономия ≥ 25% токенов на повторных вопросах.
 *
 * @module dsh-memory/benchmark
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildMemoryBlock } from './inject.js'
import { estimateTokens, indexWorkspace } from './indexer.js'
import { openStore } from './store.js'

/** Каталог бенчмарка внутри пакета. */
export const BENCH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'bench')

/** Воркспейс-фикстура по умолчанию. */
export const BENCH_WORKSPACE = join(BENCH_DIR, 'fixtures', 'project')

/** Файл с вопросами бенчмарка. */
export const BENCH_QUESTIONS_FILE = join(BENCH_DIR, 'questions', 'questions.json')

/** Сколько вопросов в сценарии MVP. */
export const BENCH_QUESTION_COUNT = 20

/** Цели MVP: hit-rate и экономия токенов на повторных вопросах. */
export const BENCH_TARGETS = Object.freeze({ hitRate: 0.2, tokenSavings: 0.25 })

/**
 * Прочитать вопросы бенчмарка и проверить контракт: ровно 20 вопросов, у
 * каждого есть `id`, `query`, `source`, источник существует в воркспейсе.
 *
 * @param {string} [file] — путь к JSON (для тестов).
 * @returns {Array<{ id: string, query: string, source: string }>} вопросы.
 */
export function loadBenchQuestions(file = BENCH_QUESTIONS_FILE) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed) || parsed.length !== BENCH_QUESTION_COUNT) {
    throw new Error(`dsh-memory: в ${file} должно быть ровно ${BENCH_QUESTION_COUNT} вопросов`)
  }
  return parsed.map((question, index) => {
    if (typeof question?.id !== 'string' || typeof question?.query !== 'string' || typeof question?.source !== 'string') {
      throw new Error(`dsh-memory: вопрос №${index + 1} в ${file} должен иметь id/query/source`)
    }
    if (question.query.trim() === '' || question.source.trim() === '') {
      throw new Error(`dsh-memory: вопрос №${index + 1} в ${file} пуст`)
    }
    return { id: question.id, query: question.query, source: question.source }
  })
}

/**
 * Прогнать бенчмарк на открытом хранилище: индексирует воркспейс (свежий
 * namespace) и отвечает на каждый вопрос через инъекцию L1.
 *
 * @param {object} options — параметры.
 * @param {import('./store.js').MemoryStore} options.store — открытое хранилище (лучше свежий временный namespace).
 * @param {string} [options.workspace] — воркспейс-фикстура.
 * @param {Array<{ id: string, query: string, source: string }>} [options.questions] — вопросы.
 * @param {() => number} [options.now] — часы индексации.
 * @param {number} [options.snippetChars] — размер сниппета (по умолчанию 300).
 * @param {number} [options.tokenBudget] — бюджет инъекции (по умолчанию 600).
 * @returns {{
 *   workspace: string, questions: number, hitRate: number, tokensBefore: number,
 *   tokensAfter: number, tokenSavings: number, targets: { hitRate: boolean, tokenSavings: boolean },
 *   passed: boolean, perQuestion: Array<Record<string, unknown>>
 * }} результат бенчмарка.
 */
export function runBenchmark({
  store,
  workspace = BENCH_WORKSPACE,
  questions = loadBenchQuestions(),
  now = () => Date.now(),
  snippetChars = 300,
  tokenBudget = 600,
} = {}) {
  if (!store || typeof store.searchEntries !== 'function') {
    throw new TypeError('dsh-memory: runBenchmark нужен открытый store (см. lib/store.js)')
  }
  if (questions.length !== BENCH_QUESTION_COUNT) {
    throw new Error(`dsh-memory: бенчмарк ждёт ${BENCH_QUESTION_COUNT} вопросов, получено ${questions.length}`)
  }

  indexWorkspace({ workspace, store, now })

  let tokensBefore = 0
  let tokensAfter = 0
  let relevantHits = 0
  /** @type {Array<Record<string, unknown>>} */
  const perQuestion = []

  for (const question of questions) {
    const sourceText = readFileSync(join(workspace, question.source), 'utf8')
    const baseline = estimateTokens(sourceText)
    const result = buildMemoryBlock(store, question.query, {
      snippetChars,
      tokenBudget,
      env: {},
      configEnabled: true,
    })
    const matchedSources = extractSources(result.block)
    const relevant = result.block !== null && matchedSources.includes(question.source)
    if (relevant) relevantHits += 1

    // Попадание экономит полный источник; промах (или нерелевантный блок) —
    // модель всё равно читает источник, плюс оплачивает бесполезную инъекцию.
    const after = relevant ? result.tokens : baseline + result.tokens
    tokensBefore += baseline
    tokensAfter += after
    perQuestion.push({
      id: question.id,
      query: question.query,
      source: question.source,
      relevant,
      before: baseline,
      after,
      blockTokens: result.tokens,
      included: result.included,
      matchedSources,
    })
  }

  const hitRate = relevantHits / questions.length
  const tokenSavings = tokensBefore === 0 ? 0 : Math.max(0, 1 - tokensAfter / tokensBefore)
  const targets = {
    hitRate: hitRate >= BENCH_TARGETS.hitRate,
    tokenSavings: tokenSavings >= BENCH_TARGETS.tokenSavings,
  }

  return {
    workspace,
    questions: questions.length,
    hitRate,
    tokensBefore,
    tokensAfter,
    tokenSavings,
    targets,
    passed: targets.hitRate && targets.tokenSavings,
    perQuestion,
  }
}

/**
 * Открыть временное хранилище для бенчмарка; закрыть и удалить после.
 *
 * @param {{ namespace?: string }} [options] — параметры.
 * @returns {{ store: import('./store.js').MemoryStore, dispose: () => void }} хранилище и очистка.
 */
export function createBenchStore({ namespace = 'benchmark' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-bench-'))
  const store = openStore({ dbPath: dir, namespace })
  return {
    store,
    dispose() {
      try {
        store.close()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}

/**
 * Отрисовать отчёт бенчмарка в markdown (для `docs/benchmark-mvp.md`).
 *
 * @param {ReturnType<typeof runBenchmark>} result — результат.
 * @returns {string} markdown без даты/времени: отчёт воспроизводим.
 */
export function renderBenchmarkReport(result) {
  const percent = (value) => `${(value * 100).toFixed(1)}%`
  const lines = [
    '# Бенчмарк MVP dsh-memory',
    '',
    'Сценарий: 20 повторяющихся вопросов по проекту, память проиндексирована заранее.',
    '«До» — полный текст источника ответа; «после» — инъекция L1 (top-k сниппетов,',
    'бюджет 600 токенов) плюс источник, если релевантного попадания не было.',
    'Попадание считается релевантным только при совпадении `source_path`.',
    '',
    '| Метрика | Значение | Цель | Итог |',
    '|---|---|---|---|',
    `| Вопросов | ${result.questions} | 20 | ${result.questions === BENCH_QUESTION_COUNT ? '✅' : '❌'} |`,
    `| hit-rate L1 | ${percent(result.hitRate)} | ≥ ${percent(BENCH_TARGETS.hitRate)} | ${result.targets.hitRate ? '✅' : '❌'} |`,
    `| Токенов «до» | ${result.tokensBefore} | — | — |`,
    `| Токенов «после» | ${result.tokensAfter} | — | — |`,
    `| Экономия токенов | ${percent(result.tokenSavings)} | ≥ ${percent(BENCH_TARGETS.tokenSavings)} | ${result.targets.tokenSavings ? '✅' : '❌'} |`,
    '',
    `Итог: **${result.passed ? 'цели достигнуты' : 'цели не достигнуты'}**.`,
    '',
    '## Вопросы',
    '',
    '| # | Вопрос | Источник | Релевантно | До | После |',
    '|---|---|---|---|---|---|',
    ...result.perQuestion.map((item, index) => `| ${index + 1} | ${escapeCell(item.query)} | \`${item.source}\` | ${item.relevant ? 'да' : 'нет'} | ${item.before} | ${item.after} |`),
    '',
    '## Воспроизведение',
    '',
    '```bash',
    'dsh-memory bench --report docs/benchmark-mvp.md',
    '```',
    '',
    'Фикстуры: `bench/fixtures/project`, вопросы: `bench/questions/questions.json`.',
    'Отчёт детерминирован: без сети, без текущей даты и без случайности.',
    '',
  ]
  return lines.join('\n')
}

/**
 * Записать отчёт в файл (создаёт каталог).
 *
 * @param {string} file — путь.
 * @param {string} content — markdown.
 * @returns {string} абсолютный путь.
 */
export function writeBenchmarkReport(file, content) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
  return file
}

/**
 * Достать `source_path` из строк блока `[memory] title — snippet (source, status)`.
 *
 * @param {string | null} block — блок инъекции.
 * @returns {string[]} источники.
 */
function extractSources(block) {
  if (typeof block !== 'string') return []
  const sources = []
  for (const match of block.matchAll(/\(([^(),]+), (?:verified|draft|stale)\)/gu)) {
    sources.push(match[1].trim())
  }
  return sources
}

/**
 * Экранировать ячейку markdown-таблицы.
 *
 * @param {string} value — текст.
 * @returns {string} безопасная ячейка.
 */
function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}
