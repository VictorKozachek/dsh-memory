/**
 * Тесты индексатора и CLI: обход воркспейса, фильтры секретов, чанкование по
 * `##` с лимитом токенов, инкрементальность по `sha256` + `mtime` и команда
 * `dsh-memory index`.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { chunkMarkdown, containsSecret, estimateTokens, indexWorkspace, isSecretPath, walkMarkdown } from '../lib/indexer.js'
import { openStore } from '../lib/store.js'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const cliBin = join(rootDir, 'bin/dsh-memory.js')

const README = `# Проект памяти

Введение: память проекта живёт в SQLite.

## Установка

Плагин ставится в профиль DSH как bundle.

## Поиск

Поиск идёт по FTS5 без модели.
`

const GUIDE = `# Руководство

## Раздел

Текст раздела руководства.
`

/** Временный каталог на тест; удаляется после него. */
function tempDir(t, prefix = 'dsh-memory-index-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Записать файл фикстуры, создав каталоги. */
function writeFile(root, path, content) {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

/**
 * Фикстурный воркспейс: два полезных markdown-файла, служебные каталоги,
 * секреты по имени и по содержимому.
 */
function buildWorkspace(t) {
  const root = tempDir(t)
  writeFile(root, 'README.md', README)
  writeFile(root, 'docs/guide.md', GUIDE)
  writeFile(root, 'docs/notes.txt', 'это не markdown и индексироваться не должно\n')

  for (const directory of ['.git', 'node_modules', 'dist', 'build', 'tmp', '.cache', 'worktrees/001']) {
    writeFile(root, `${directory}/README.md`, '# Служебный файл\n\n## Раздел\n\nне индексируется\n')
  }

  // Секреты по имени файла и по содержимому.
  writeFile(root, 'docs/api-secret.md', '# Секрет\n\nтекст\n')
  writeFile(root, 'docs/credentials.md', '# Доступы\n\nтекст\n')
  writeFile(root, '.git-credentials', 'https://user:pass@example.com\n')
  writeFile(root, 'secrets/prod.env', 'API_KEY=1\n')
  writeFile(root, 'docs/private-key.md', '# Ключ\n\n-----BEGIN RSA PRIVATE KEY-----\nMIIExample\n')
  writeFile(root, 'docs/github-token.md', '# Токен\n\nghp_abcdefghijklmnopqrstuvwxyz0123456789\n')
  writeFile(root, 'docs/openai-key.md', '# Ключ API\n\nsk-abcdefghijklmnopqrstuvwxyz012345\n')
  writeFile(root, 'docs/aws.md', '# AWS\n\nAKIAIOSFODNN7EXAMPLE\n')
  return root
}

/** Открыть хранилище на временном каталоге и закрыть после теста. */
function openTempStore(t, namespace = 'demo') {
  const store = openStore({ dbPath: tempDir(t, 'dsh-memory-db-'), namespace })
  t.after(() => store.close())
  return store
}

test('walkMarkdown обходит *.md и пропускает служебные каталоги', (t) => {
  const root = buildWorkspace(t)
  assert.deepEqual(walkMarkdown(root), [
    'README.md',
    'docs/api-secret.md',
    'docs/aws.md',
    'docs/credentials.md',
    'docs/github-token.md',
    'docs/guide.md',
    'docs/openai-key.md',
    'docs/private-key.md',
  ])
})

test('indexWorkspace индексирует документы и заводит провенанс', (t) => {
  const root = buildWorkspace(t)
  const store = openTempStore(t)
  const summary = indexWorkspace({ workspace: root, store, now: () => 1_000 })

  assert.equal(summary.files, 8)
  assert.equal(summary.indexed, 2)
  assert.equal(summary.unchanged, 0)
  assert.equal(summary.skipped, 6)
  assert.equal(summary.chunks, 4)
  assert.deepEqual(summary.failed, [])
  assert.equal(summary.namespace, 'demo')

  const paths = store.database
    .prepare('SELECT DISTINCT source_path FROM entries ORDER BY source_path')
    .all()
    .map((row) => row.source_path)
  assert.deepEqual(paths, ['README.md', 'docs/guide.md'])

  const titles = store.database.prepare('SELECT title FROM entries').all().map((row) => row.title).sort()
  assert.deepEqual(titles, [
    'README.md → Поиск',
    'README.md → Проект памяти',
    'README.md → Установка',
    'docs/guide.md → Раздел',
  ])

  const meta = store.database.prepare('SELECT DISTINCT kind, status, confidence, author FROM entries').all().map((row) => ({ ...row }))
  assert.deepEqual(meta, [{ kind: 'doc', status: 'verified', confidence: 1, author: 'indexer' }])

  const source = store.getSource('README.md')
  assert.equal(typeof source.sha256, 'string')
  assert.equal(source.indexed_at, 1_000)
  assert.equal(store.getSource('docs/notes.txt'), null)
})

test('секреты не попадают в индекс и перечислены в отчёте', (t) => {
  const root = buildWorkspace(t)
  const store = openTempStore(t)
  const summary = indexWorkspace({ workspace: root, store })

  assert.deepEqual(summary.secrets.sort(), [
    'docs/api-secret.md',
    'docs/aws.md',
    'docs/credentials.md',
    'docs/github-token.md',
    'docs/openai-key.md',
    'docs/private-key.md',
  ])
  for (const path of summary.secrets) {
    assert.equal(store.getSource(path), null, `источник ${path} попал в индекс`)
    assert.equal(store.database.prepare('SELECT count(*) AS n FROM entries WHERE source_path = ?').get(path).n, 0)
  }
})

test('фильтры секретов: имена файлов и маркеры в тексте', () => {
  for (const path of ['.env', 'prod.env', 'config/prod.env', 'docs/api-secret.md', 'credentials.json', '.git-credentials']) {
    assert.ok(isSecretPath(path), `путь ${path} должен считаться секретом`)
  }
  assert.ok(!isSecretPath('README.md'))
  assert.ok(!isSecretPath('docs/guide.md'))

  assert.ok(containsSecret('-----BEGIN RSA PRIVATE KEY-----'))
  assert.ok(containsSecret('token ghp_abcdefghijklmnopqrstuvwxyz0123456789'))
  assert.ok(containsSecret('key sk-abcdefghijklmnopqrstuvwxyz012345'))
  assert.ok(containsSecret('AKIAIOSFODNN7EXAMPLE'))
  // Ложных срабатываний на обычном тексте быть не должно.
  assert.ok(!containsSecret('task-oriented и risk-management — обычная документация'))
})

test('чанкование по ## и лимит токенов', () => {
  const long = `# Документ\n\n## Короткий\n\nкороткий текст\n\n## Длинный\n\n${'слово '.repeat(1_200)}\n`
  const chunks = chunkMarkdown('docs/long.md', long, { maxChunkTokens: 100 })

  assert.ok(chunks.some((chunk) => chunk.title === 'docs/long.md → Короткий'))
  const longParts = chunks.filter((chunk) => chunk.title.startsWith('docs/long.md → Длинный'))
  assert.ok(longParts.length > 1, 'длинный раздел должен быть разрезан')
  assert.equal(longParts[0].title, 'docs/long.md → Длинный (часть 1)')

  for (const chunk of chunks) {
    assert.equal(chunk.sourcePath, 'docs/long.md')
    assert.ok(chunk.tokens <= 100, `чанк длиннее лимита: ${chunk.tokens}`)
    assert.ok(estimateTokens(chunk.text) <= 100)
    assert.ok(chunk.text.trim() !== '')
  }
})

test('по умолчанию чанк не длиннее 800 токенов (оценка)', () => {
  const chunks = chunkMarkdown('big.md', `## Большой раздел\n\n${'текст '.repeat(2_000)}`)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(chunk.tokens <= 800, `чанк длиннее 800: ${chunk.tokens}`)
  }
})

test('инкрементальность по sha256 + mtime: неизменённые файлы не переиндексируются', (t) => {
  const root = buildWorkspace(t)
  const store = openTempStore(t)

  const first = indexWorkspace({ workspace: root, store, now: () => 1_000 })
  assert.equal(first.indexed, 2)
  assert.equal(first.chunks, 4)

  const second = indexWorkspace({ workspace: root, store, now: () => 2_000 })
  assert.equal(second.indexed, 0)
  assert.equal(second.unchanged, 2)
  assert.equal(second.chunks, 0)
  assert.equal(second.skipped, first.skipped)

  // Меняем один файл: переиндексируется только он, старые чанки заменяются.
  const guide = join(root, 'docs/guide.md')
  writeFileSync(guide, '# Руководство\n\n## Новый раздел\n\nсовсем новый текст\n')
  const future = new Date(Date.now() + 10_000)
  utimesSync(guide, future, future)

  const third = indexWorkspace({ workspace: root, store })
  assert.equal(third.indexed, 1)
  assert.equal(third.unchanged, 1)

  const guideTitles = store.database
    .prepare('SELECT title FROM entries WHERE source_path = ?')
    .all('docs/guide.md')
    .map((row) => row.title)
  assert.deepEqual(guideTitles, ['docs/guide.md → Новый раздел'])
  assert.equal(store.searchEntries('руководства').length, 0, 'старый чанк остался в FTS')
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM entries WHERE source_path = ?').get('README.md').n, 3)
})

test('CLI: dsh-memory index --workspace --db-path --json', (t) => {
  const root = buildWorkspace(t)
  const dbDir = tempDir(t, 'dsh-memory-cli-')

  const stdout = execFileSync(process.execPath, [cliBin, 'index', '--workspace', root, '--db-path', dbDir, '--json'], {
    encoding: 'utf8',
  })
  const summary = JSON.parse(stdout)
  assert.equal(summary.indexed, 2)
  assert.equal(summary.skipped, 6)
  assert.equal(summary.chunks, 4)
  assert.equal(summary.namespace, basename(root))
  assert.ok(existsSync(join(dbDir, `${basename(root)}.db`)), 'CLI не создал файл БД')
})

test('CLI: DSH_MEMORY_DB и --namespace перекрывают значения по умолчанию', (t) => {
  const root = buildWorkspace(t)
  const dbDir = tempDir(t, 'dsh-memory-cli-')

  const stdout = execFileSync(
    process.execPath,
    [cliBin, 'index', '--workspace', root, '--namespace', 'cli-demo', '--json'],
    { encoding: 'utf8', env: { ...process.env, DSH_MEMORY_DB: dbDir } },
  )
  const summary = JSON.parse(stdout)
  assert.equal(summary.namespace, 'cli-demo')
  assert.ok(existsSync(join(dbDir, 'cli-demo.db')))
})

test('CLI: подсказка и ошибка аргументов', (t) => {
  const help = execFileSync(process.execPath, [cliBin, '--help'], { encoding: 'utf8' })
  assert.match(help, /dsh-memory index --workspace/)

  const failure = spawnSync(process.execPath, [cliBin, 'index', '--nope'], { encoding: 'utf8' })
  assert.equal(failure.status, 2)
  assert.match(failure.stderr, /неизвестный аргумент/)
})

test('package.json публикует CLI-команду dsh-memory', () => {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  assert.equal(pkg.bin['dsh-memory'], './bin/dsh-memory.js')
  // В `files` — только сам CLI-файл: репозиторные bin/*.sh в пакет не попадают.
  assert.ok(pkg.files.includes('bin/dsh-memory.js'))
  assert.ok(existsSync(join(rootDir, 'bin/dsh-memory.js')))
})
