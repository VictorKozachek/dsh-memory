/**
 * Индексатор документов `dsh-memory` (задачи 003, 019).
 *
 * Обходит markdown-файлы воркспейса, режет их по заголовкам `##` на чанки,
 * отбрасывает секреты и пишет чанки в хранилище (`lib/store.js`) как записи
 * `kind: doc` с провенансом `source_path`. Инкрементальность — по `sha256`
 * (решает, изменилось ли содержимое) и `mtime` (метаданные файла): `touch` без
 * изменения текста файл не переиндексирует, а правка содержимого — да.
 *
 * Статус чанка — `verified`, `confidence: 1`: это дословная цитата файла
 * воркспейса с провенансом, а не ответ модели. Правило «verified только после
 * ревью» относится к записям `memory.write` (задачи 005–006); здесь источник —
 * сам файл, и его изменение переиндексирует запись.
 *
 * Изменённый файл переиндексируется целиком и атомарно: в транзакции старые
 * чанки индексатора удаляются (`store.deleteIndexedChunks` — только
 * `kind: doc` + `author: indexer`), новые вставляются, источник отмечается.
 * Сбой посередине откатывает файл целиком, запись `memory.write` с тем же
 * `source_path` не трогается.
 *
 * Изменённые/удалённые файлы (задача 014): старые чанки не удаляются, а
 * помечаются `stale` (история/аудит), новые чанки вставляются или возвращаются
 * из `stale` по тому же hash; источник исчезнувшего файла удаляется. Записи
 * `memory.write` с тем же `source_path` индексатор не трогает — у них свой
 * `memory.invalidate`. Карточки доски и ADR индексируются как `decision`
 * (TTL 180 дней), README компонентов — как `doc`.
 *
 * Секреты (задача 019): файлы с опасными именами (`*.env`, `*secret*`,
 * `*credential*`, `.git-credentials`) не читаются в индекс вовсе; в тексте
 * ищутся ключи по форме — PEM-заголовок в начале строки
 * (`-----BEGIN … PRIVATE KEY-----`), `ghp_` + 36 символов, `sk-` + 48,
 * `AKIA` + 16 заглавных. Голые упоминания маркеров и PEM-заголовок посреди
 * описания (README, спека, карточки задач) секретом не считаются, иначе
 * документация проекта выпадает из памяти. Ключ в inline-code, списке или
 * fenced-блоке ловится — маскировать код нельзя. Пути отсеянных файлов
 * возвращаются в `summary.secrets`.
 *
 * @module dsh-memory/indexer
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'

import { entryHash } from './store.js'

/** Что индексируем по умолчанию: вся markdown-документация, включая доску и ADR. */
export const DEFAULT_INCLUDE = Object.freeze(['**/*.md'])

/**
 * Какие пути считаются решениями (`kind: decision`, TTL 180 дней): карточки
 * доски и ADR. README компонентов и прочая документация — `doc` без TTL.
 */
const DECISION_PATHS = Object.freeze([
  /^\.kanban\/tasks\/[^/]+\.md$/iu,
  /^docs\/adr\/[^/]+\.md$/iu,
])

/**
 * Что пропускаем по умолчанию: служебные каталоги, перечисленные в карточке
 * 003 и спеке (`.git`, `node_modules`, сборочные и временные каталоги,
 * `worktrees` — код задач в них не является документацией проекта).
 */
export const DEFAULT_EXCLUDE = Object.freeze([
  '.git/**',
  'node_modules/**',
  'dist/**',
  'build/**',
  'tmp/**',
  '.cache/**',
  'worktrees/**',
])

/** Предел чанка в «токенах» (оценка, см. {@link estimateTokens}). */
export const DEFAULT_MAX_CHUNK_TOKENS = 800

/**
 * Тип индексируемой записи по пути: карточки доски и ADR — решения
 * (`decision`, TTL 180 дней), остальная документация — `doc` (без TTL).
 *
 * @param {string} path — путь от корня воркспейса (прямые слеши).
 * @returns {'decision' | 'doc'} тип записи.
 */
export function kindForPath(path) {
  const value = toPosix(String(path ?? ''))
  return DECISION_PATHS.some((pattern) => pattern.test(value)) ? 'decision' : 'doc'
}

/**
 * Оценка числа токенов в тексте. Точного токенайзера в плагине нет, а тянуть
 * его ради бюджета инъекции не хочется: считаем ~3 символа на токен — это
 * консервативно для русского текста (там ~2–3 символа на токен), поэтому
 * чанк, прошедший проверку, останется в пределах лимита и в реальном
 * токенайзере.
 *
 * @param {string} text — текст.
 * @returns {number} оценка токенов.
 */
export function estimateTokens(text) {
  return Math.ceil([...String(text ?? '')].length / 3)
}

/**
 * Опасное имя файла: секреты отсекаются до чтения содержимого.
 *
 * @param {string} path — путь от корня воркспейса (или просто имя).
 * @returns {boolean} true, если файл похож на секрет.
 */
export function isSecretPath(path) {
  const name = basename(toPosix(String(path ?? ''))).toLowerCase()
  if (name === '.git-credentials' || name === 'git-credentials') return true
  if (name === '.env' || name.endsWith('.env') || name.startsWith('.env.')) return true
  return name.includes('secret') || name.includes('credential')
}

/**
 * Маркеры ключей в тексте — по форме и длине ключа, а не по подстроке.
 * Границы слева/справа не дают `task-oriented` или `risk-management` попасть
 * под `sk-`. Голые упоминания `ghp_`, `sk-`, `AKIA` (без формы ключа) секретом
 * не считаются, а PEM-заголовок опознаётся только в начале строки — так он
 * выглядит в настоящем ключе и не выглядит в описании паттерна посреди
 * предложения. Ключ в inline-code, списке или fenced-блоке по-прежнему ловится:
 * маскировать код нельзя, иначе настоящий ключ уйдёт в индекс и в сниппеты.
 *
 * @type {ReadonlyArray<RegExp>}
 */
const SECRET_MARKERS = [
  // PEM-заголовок приватного ключа: RSA/EC/OPENSSH/PGP и т.п. «-----BEGIN» без
  // «PRIVATE KEY» — это описание паттерна, а не ключ.
  /^[ \t]*-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/m,
  // GitHub PAT: `ghp_` + 36 символов.
  /(^|[^A-Za-z0-9_])ghp_[A-Za-z0-9]{36,}/,
  // OpenAI-подобный ключ: `sk-` + 48 символов.
  /(^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{48,}/,
  // AWS access key id: `AKIA` + 16 заглавных букв/цифр.
  /(^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}(?![0-9A-Z])/,
]

/**
 * Есть ли в тексте настоящий ключ. Скан идёт по сырому тексту: inline-code и
 * fenced-блоки не маскируются (это защита от утечки реального ключа в индекс).
 * Документация проекта не срабатывает потому, что маркеры ищутся по форме
 * (длина ключа), а PEM-заголовок — в начале строки, а не посреди описания.
 *
 * @param {string} text — содержимое файла.
 * @returns {boolean} true, если файл нельзя индексировать.
 */
export function containsSecret(text) {
  const value = String(text ?? '')
  return SECRET_MARKERS.some((pattern) => pattern.test(value))
}

/**
 * Найти markdown-файлы воркспейса по include-шаблонам, пропуская exclude.
 *
 * @param {string} workspace — корень воркспейса.
 * @param {{ include?: readonly string[], exclude?: readonly string[] }} [options] — шаблоны обхода.
 * @returns {string[]} относительные пути с прямыми слешами, отсортированы.
 */
export function walkMarkdown(workspace, { include = DEFAULT_INCLUDE, exclude = DEFAULT_EXCLUDE } = {}) {
  const root = resolve(requireString(workspace, 'workspace'))
  const files = []

  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const path = toPosix(relative(root, absolute))
      if (entry.isDirectory()) {
        if (!isExcluded(path, exclude)) visit(absolute)
      } else if (entry.isFile() && matchesAny(path, include) && !isExcluded(path, exclude)) {
        files.push(path)
      }
    }
  }

  visit(root)
  return files.sort()
}

/**
 * Разрезать markdown на чанки по заголовкам `##` и по лимиту токенов.
 *
 * @param {string} sourcePath — путь файла от корня воркспейса (идёт в title и source_path).
 * @param {string} markdown — содержимое файла.
 * @param {{ maxChunkTokens?: number }} [options] — предел чанка.
 * @returns {Array<{ title: string, text: string, sourcePath: string, tokens: number }>} чанки.
 */
export function chunkMarkdown(sourcePath, markdown, { maxChunkTokens = DEFAULT_MAX_CHUNK_TOKENS } = {}) {
  const file = requireString(sourcePath, 'sourcePath')
  const limit = Number.isSafeInteger(maxChunkTokens) && maxChunkTokens > 0 ? maxChunkTokens : DEFAULT_MAX_CHUNK_TOKENS
  const chunks = []

  for (const section of splitSections(String(markdown ?? ''))) {
    const parts = splitText(section.text.trim(), limit)
    for (const [index, text] of parts.entries()) {
      chunks.push({
        title: parts.length > 1 ? `${file} → ${section.title} (часть ${index + 1})` : `${file} → ${section.title}`,
        text,
        sourcePath: file,
        tokens: estimateTokens(text),
      })
    }
  }

  return chunks
}

/**
 * Проиндексировать воркспейс в открытое хранилище.
 *
 * @param {object} options — параметры индексации.
 * @param {string} options.workspace — корень воркспейса.
 * @param {import('./store.js').MemoryStore} options.store — открытое хранилище нужного namespace.
 * @param {readonly string[]} [options.include] — что индексировать (по умолчанию все `*.md` на любой глубине).
 * @param {readonly string[]} [options.exclude] — что пропускать (по умолчанию {@link DEFAULT_EXCLUDE}).
 * @param {number} [options.maxChunkTokens] — предел чанка.
 * @param {() => number} [options.now] — часы для `indexed_at`/`created_at`.
 * @returns {{
 *   workspace: string, namespace: string, files: number, indexed: number,
 *   unchanged: number, skipped: number, secrets: string[], chunks: number,
 *   revived: number, deduped: number, stale: number, removed: string[],
 *   failed: Array<{ path: string, error: string }>
 * }} отчёт об индексации; `stale` — сколько старых чанков помечено stale,
 *   `removed` — пути источников, которых больше нет в обходе.
 */
export function indexWorkspace(options) {
  const {
    workspace,
    store,
    include = DEFAULT_INCLUDE,
    exclude = DEFAULT_EXCLUDE,
    maxChunkTokens = DEFAULT_MAX_CHUNK_TOKENS,
    now = () => Date.now(),
  } = options ?? {}

  if (!store || typeof store.insertEntry !== 'function' || typeof store.getSource !== 'function') {
    throw new TypeError('dsh-memory: indexWorkspace нужен открытый store (см. lib/store.js)')
  }

  const root = resolve(requireString(workspace, 'workspace'))
  const files = walkMarkdown(root, { include, exclude })
  /** Пути, которые остались в индексе в этом прогоне (файлы, которые не удалены). */
  const kept = new Set()
  const summary = {
    workspace: root,
    namespace: store.namespace,
    files: files.length,
    indexed: 0,
    unchanged: 0,
    skipped: 0,
    secrets: [],
    chunks: 0,
    revived: 0,
    deduped: 0,
    stale: 0,
    removed: [],
    failed: [],
  }

  for (const sourcePath of files) {
    if (isSecretPath(sourcePath)) {
      summary.skipped += 1
      summary.secrets.push(sourcePath)
      continue
    }

    let content
    let stat
    try {
      content = readFileSync(join(root, sourcePath), 'utf8')
      stat = statSync(join(root, sourcePath))
    } catch (error) {
      // Файл существует, но не читается: не считаем его удалённым, иначе
      // случайный сбой пометил бы живой индекс stale.
      kept.add(sourcePath)
      summary.failed.push({ path: sourcePath, error: error instanceof Error ? error.message : String(error) })
      continue
    }

    if (containsSecret(content)) {
      summary.skipped += 1
      summary.secrets.push(sourcePath)
      continue
    }

    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex')
    const mtime = Math.floor(stat.mtimeMs)
    const source = store.getSource(sourcePath)
    if (source && source.sha256 === sha256) {
      // Содержимое не изменилось. `touch` меняет только mtime — это метаданные,
      // а не повод переиндексировать: обновляем время файла и идём дальше.
      if (source.mtime !== mtime) {
        store.upsertSource({ path: sourcePath, sha256, mtime, indexedAt: source.indexed_at })
      }
      kept.add(sourcePath)
      summary.unchanged += 1
      continue
    }

    const timestamp = now()
    const kind = kindForPath(sourcePath)
    const chunks = chunkMarkdown(sourcePath, content, { maxChunkTokens })
    let inserted = 0
    let revived = 0
    let deduped = 0
    let staled = 0
    try {
      store.transaction(() => {
        // Старые чанки файла не удаляем, а помечаем stale (задача 014): при
        // изменении файла устаревшее знание должно исчезнуть из выдачи, но
        // остаться следом для аудита. Записи memory.write не трогаются.
        staled = store.staleIndexedChunks(sourcePath, timestamp)
        for (const chunk of chunks) {
          const hash = entryHash(kind, chunk.title, chunk.text)
          const existing = store.findEntryByHash(hash)
          if (existing && existing.author === 'indexer' && existing.source_path === sourcePath) {
            // Чанк не изменился (тот же hash): возвращаем его из stale.
            if (existing.status !== 'verified') {
              store.updateEntry(existing.id, { status: 'verified', updatedAt: timestamp })
              revived += 1
            } else {
              deduped += 1
            }
            continue
          }
          try {
            store.insertEntry({
              kind,
              title: chunk.title,
              text: chunk.text,
              status: 'verified',
              confidence: 1,
              sourcePath,
              author: 'indexer',
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            inserted += 1
          } catch (error) {
            // Одинаковые чанки (например, повтор абзаца) дедуплицируются по hash.
            if (error?.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: entries\.hash/.test(error.message)) {
              deduped += 1
            } else {
              throw error
            }
          }
        }
        store.upsertSource({ path: sourcePath, sha256, mtime, indexedAt: timestamp })
      })
    } catch (error) {
      // Транзакция откатила файл целиком: старые чанки на месте, source не
      // обновлён, следующий прогон повторит. Остальные файлы не страдают.
      summary.failed.push({ path: sourcePath, error: error instanceof Error ? error.message : String(error) })
      continue
    }

    kept.add(sourcePath)
    summary.chunks += inserted + revived
    summary.revived += revived
    summary.deduped += deduped
    summary.stale += staled
    summary.indexed += 1
  }

  // Файлы, которых больше нет в обходе (удалены, исключены или стали
  // секретами): их чанки — stale, источник удаляем. Это и есть «удалили файл →
  // запись не выдаётся» (критерий 014).
  for (const source of store.listSources()) {
    if (kept.has(source.path)) continue
    summary.stale += store.staleIndexedChunks(source.path, now())
    store.deleteSource(source.path)
    summary.removed.push(source.path)
  }

  return summary
}

/**
 * Разбить markdown на секции по заголовкам `##` (внутри code fence заголовки
 * не считаются). Заголовок `#` первого уровня даёт имя файла в title, сам в
 * текст чанка не попадает.
 *
 * @param {string} markdown — содержимое.
 * @returns {Array<{ title: string, text: string }>} секции.
 */
function splitSections(markdown) {
  /** @type {Array<{ title: string, text: string }>} */
  const sections = []
  let title = null
  let fileTitle = null
  let buffer = []
  let fenced = false

  const flush = () => {
    sections.push({ title: title ?? fileTitle ?? 'введение', text: buffer.join('\n') })
    buffer = []
  }

  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fenced = !fenced
    if (!fenced) {
      const heading2 = /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line)
      if (heading2) {
        flush()
        title = heading2[1].trim()
        continue
      }
      if (title === null) {
        const heading1 = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line)
        if (heading1) {
          fileTitle = heading1[1].trim()
          continue
        }
      }
    }
    buffer.push(line)
  }
  flush()

  return sections.filter((section) => section.text.trim() !== '')
}

/**
 * Разрезать текст секции на части не длиннее лимита: сначала по абзацам,
 * затем — по словам, а слишком длинное «слово» — по символам.
 *
 * @param {string} text — текст секции.
 * @param {number} limit — предел в токенах (оценка).
 * @returns {string[]} части.
 */
function splitText(text, limit) {
  if (estimateTokens(text) <= limit) return [text]

  const blocks = []
  for (const paragraph of text.split(/\n\s*\n/)) {
    const block = paragraph.trim()
    if (block !== '') blocks.push(...hardSplit(block, limit))
  }

  const chunks = []
  let current = ''
  for (const block of blocks) {
    const candidate = current === '' ? block : `${current}\n\n${block}`
    if (estimateTokens(candidate) <= limit) {
      current = candidate
    } else {
      if (current !== '') chunks.push(current)
      current = block
    }
  }
  if (current !== '') chunks.push(current)
  return chunks
}

/**
 * Разрезать один абзац, который не влезает в лимит, по словам; слово
 * длиннее лимита режется по символам (лимит × 3 символа).
 *
 * @param {string} block — абзац.
 * @param {number} limit — предел в токенах (оценка).
 * @returns {string[]} части не длиннее лимита.
 */
function hardSplit(block, limit) {
  if (estimateTokens(block) <= limit) return [block]
  const maxChars = limit * 3
  const pieces = []
  let current = ''

  for (const token of block.split(/(\s+)/)) {
    if (token === '') continue
    const candidate = current + token
    if (estimateTokens(candidate) <= limit) {
      current = candidate
      continue
    }
    if (current.trim() !== '') pieces.push(current.trim())
    current = token
    while (estimateTokens(current) > limit) {
      const chars = [...current]
      pieces.push(chars.slice(0, maxChars).join('').trim())
      current = chars.slice(maxChars).join('')
    }
  }
  if (current.trim() !== '') pieces.push(current.trim())
  return pieces.filter((piece) => piece !== '')
}

/**
 * Проверить путь на соответствие exclude-шаблонам.
 *
 * @param {string} path — относительный путь с прямыми слешами.
 * @param {readonly string[]} patterns — шаблоны.
 * @returns {boolean} true, если путь исключён.
 */
function isExcluded(path, patterns) {
  for (const pattern of patterns) {
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3)
      if (path === prefix || path.startsWith(`${prefix}/`) || path.endsWith(`/${prefix}`) || path.includes(`/${prefix}/`)) {
        return true
      }
    } else if (matchesAny(path, [pattern])) {
      return true
    }
  }
  return false
}

/**
 * Проверить путь хотя бы по одному include-шаблону.
 *
 * @param {string} path — относительный путь с прямыми слешами.
 * @param {readonly string[]} patterns — шаблоны.
 * @returns {boolean} true, если путь подходит.
 */
function matchesAny(path, patterns) {
  for (const pattern of patterns) {
    if (pattern.includes('/')) {
      if (globToRegExp(pattern).test(path)) return true
    } else if (globToRegExp(pattern).test(basename(path))) {
      return true
    }
  }
  return false
}

/**
 * Скомпилировать glob-шаблон в регулярное выражение: `**` — любая глубина,
 * `*` — в пределах сегмента, `?` — один символ.
 *
 * @param {string} pattern — glob-шаблон.
 * @returns {RegExp} регулярное выражение.
 */
function globToRegExp(pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

/**
 * Привести путь к прямым слешам.
 *
 * @param {string} path — путь.
 * @returns {string} путь с `/`.
 */
function toPosix(path) {
  return sep === '/' ? path : path.split(sep).join('/')
}

/**
 * Проверить, что значение — непустая строка.
 *
 * @param {unknown} value — значение.
 * @param {string} field — имя поля для ошибки.
 * @returns {string} исходная строка.
 */
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`dsh-memory: поле "${field}" должно быть непустой строкой`)
  }
  return value
}
