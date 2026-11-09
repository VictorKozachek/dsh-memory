/**
 * Хранилище `dsh-memory`: SQLite поверх штатного `node:sqlite`.
 *
 * Зачем свой слой: плагину нужны долговечные записи с FTS5 и жёсткой
 * дедупликацией по `hash`, а внешняя зависимость (`better-sqlite3`) тянет
 * нативную сборку в профиль DSH. `node:sqlite` есть в рантайме DSH (Node 24),
 * поэтому пакет остаётся без зависимостей.
 *
 * Раскладка: `db_path` из конфига — каталог (`~/.dsh/memory`), файл на
 * namespace — `<каталог>/<namespace>.db` (`databaseFile`). Namespace дублируется
 * колонкой `entries.namespace`, и каждый запрос хранилища фильтруется по нему:
 * если один файл когда-нибудь откроют под двумя namespace, записи не смешаются.
 * `UNIQUE(hash)` — глобальный для файла, как в спецификации (§5.1): при
 * штатной раскладке «файл на namespace» коллизии между namespace невозможны.
 *
 * Миграции идемпотентны: версия схемы живёт в `PRAGMA user_version`, шаг
 * применяется один раз, повторное открытие БД ничего не делает. WAL включён
 * на каждом открытии — он переживает перезапуск, но pragma дешёвая.
 *
 * @module dsh-memory/store
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Сколько записей `searchEntries` отдаёт, если `limit` не задан. */
const DEFAULT_SEARCH_LIMIT = 10

/** Таймаут ожидания блокировки БД по умолчанию. */
const DEFAULT_BUSY_TIMEOUT_MS = 5_000

/** Версия схемы: растёт вместе с {@link MIGRATIONS}. */
export const SCHEMA_VERSION = 2

/**
 * Миграции по порядку. `version` — номер шага, он же пишется в
 * `PRAGMA user_version`; SQL шага целиком выполняется в одной транзакции.
 *
 * Схема повторяет спецификацию (§5.1): `sources`, `entries`, `entries_fts`
 * (FTS5 с синхронизацией триггерами), `metrics`.
 *
 * @type {ReadonlyArray<{ version: number, name: string, sql: string }>}
 */
const MIGRATIONS = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE sources (
        path       TEXT PRIMARY KEY,
        sha256     TEXT NOT NULL,
        indexed_at INTEGER NOT NULL,
        mtime      INTEGER NOT NULL
      );

      CREATE TABLE entries (
        id          INTEGER PRIMARY KEY,
        namespace   TEXT NOT NULL,
        kind        TEXT NOT NULL,
        title       TEXT NOT NULL,
        text        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'draft',
        confidence  REAL NOT NULL DEFAULT 0,
        source_path TEXT,
        source_ref  TEXT,
        author      TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        hash        TEXT NOT NULL UNIQUE
      );

      CREATE INDEX entries_namespace ON entries(namespace);
      CREATE INDEX entries_namespace_status ON entries(namespace, status);

      CREATE VIRTUAL TABLE entries_fts USING fts5(
        title,
        text,
        content='entries',
        content_rowid='id'
      );

      CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
      END;

      CREATE TRIGGER entries_fts_delete AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, text)
          VALUES ('delete', old.id, old.title, old.text);
      END;

      CREATE TRIGGER entries_fts_update AFTER UPDATE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, text)
          VALUES ('delete', old.id, old.title, old.text);
        INSERT INTO entries_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
      END;

      CREATE TABLE metrics (
        ts      INTEGER NOT NULL,
        event   TEXT NOT NULL,
        payload TEXT
      );
    `,
  },
  {
    version: 2,
    name: 'entry sources',
    sql: `
      CREATE TABLE entry_sources (
        entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        path     TEXT NOT NULL DEFAULT '',
        ref      TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (entry_id, path, ref)
      ) WITHOUT ROWID;

      CREATE INDEX entry_sources_path ON entry_sources(path);
      CREATE INDEX entry_sources_ref ON entry_sources(ref);
    `,
  },
]

/**
 * Хэш записи: `sha256(kind|title|text)`, как в спецификации (§5.1). Поле
 * `hash` в БД уникально — по нему потом дедуплицирует `memory.write`.
 *
 * @param {string} kind — тип записи (`doc`, `decision`, `fact`, `answer`, `code-note`).
 * @param {string} title — заголовок записи.
 * @param {string} text — полный текст.
 * @returns {string} hex-представление SHA-256.
 */
export function entryHash(kind, title, text) {
  return createHash('sha256')
    .update(`${requireString(kind, 'kind')}|${requireString(title, 'title')}|${requireString(text, 'text')}`, 'utf8')
    .digest('hex')
}

/**
 * Путь к файлу БД: `db_path` из конфига — каталог, namespace — имя файла.
 * `~` раскрывается в домашний каталог, разделители пути в namespace
 * заменяются на `_`, чтобы namespace не мог вывести файл за пределы каталога.
 *
 * @param {string} dbPath — каталог из конфига (`db_path`, например `~/.dsh/memory`).
 * @param {string} namespace — namespace воркспейса.
 * @returns {string} абсолютный путь к файлу `<dbPath>/<namespace>.db`.
 */
export function databaseFile(dbPath, namespace) {
  const directory = expandHome(requireString(dbPath, 'dbPath'))
  return join(resolve(directory), `${namespaceSlug(namespace)}.db`)
}

/**
 * Открыть хранилище: создать каталог, включить WAL, применить миграции.
 *
 * Синхронный: `node:sqlite` синхронный, а объём памяти проекта небольшой.
 * Ошибка открытия (нет прав, битый файл) пробрасывается как есть — вызывающий
 * решает, молчать ли (в плагине — да, ход не ломается).
 *
 * @param {object} options — параметры открытия.
 * @param {string} options.dbPath — каталог с файлами БД (поле `db_path` конфига).
 * @param {string} options.namespace — namespace воркспейса; все запросы фильтруются по нему.
 * @param {number} [options.busyTimeoutMs] — сколько ждать снятия блокировки БД.
 * @param {() => number} [options.now] — часы для `created_at`/`updated_at` (подменяются в тестах).
 * @returns {MemoryStore} открытое хранилище.
 */
export function openStore(options) {
  const { dbPath, namespace, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS, now = () => Date.now() } = options ?? {}
  const file = databaseFile(dbPath, namespace)
  const timeout = Number.isSafeInteger(busyTimeoutMs) && busyTimeoutMs >= 0 ? busyTimeoutMs : DEFAULT_BUSY_TIMEOUT_MS

  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    db.exec(`PRAGMA busy_timeout = ${timeout}`)
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA journal_mode = WAL')
    migrate(db)
  } catch (error) {
    db.close()
    throw error
  }
  return new MemoryStore(db, { namespace, file, now })
}

/**
 * Применить недостающие миграции. Идемпотентно: всё, что уже записано в
 * `PRAGMA user_version`, повторно не выполняется.
 *
 * @param {DatabaseSync} db — открытая БД.
 * @returns {void}
 */
function migrate(db) {
  const row = db.prepare('PRAGMA user_version').get()
  const current = Number(row?.user_version ?? 0)
  if (current > SCHEMA_VERSION) {
    throw new Error(`dsh-memory: файл БД новее плагина (схема ${current}, поддерживается ${SCHEMA_VERSION})`)
  }
  for (const migration of MIGRATIONS) {
    if (current >= migration.version) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(migration.sql)
      // PRAGMA не принимает параметр — версия подставляется из константы миграции.
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}

/**
 * Открытое хранилище одного namespace.
 *
 * Все методы выборки фильтруют по namespace, все вставки его проставляют.
 * `database` — аварийный люк для CLI и тестов (проверка схемы, служебные
 * запросы); прикладной код должен ходить через методы.
 */
export class MemoryStore {
  /** @type {DatabaseSync} */
  #db
  /** @type {string} */
  #namespace
  /** @type {string} */
  #file
  /** @type {() => number} */
  #now

  /**
   * @param {DatabaseSync} db — открытая БД с применёнными миграциями.
   * @param {{ namespace: string, file: string, now: () => number }} options — параметры хранилища.
   */
  constructor(db, { namespace, file, now }) {
    this.#db = db
    this.#namespace = namespace
    this.#file = file
    this.#now = now
  }

  /** Namespace, к которому привязано хранилище. */
  get namespace() {
    return this.#namespace
  }

  /** Путь к файлу БД. */
  get file() {
    return this.#file
  }

  /** Аварийный люк к `node:sqlite` (диагностика, служебные запросы CLI). */
  get database() {
    return this.#db
  }

  /**
   * Вставить запись. `hash` считается из `kind|title|text`, если не передан.
   * Дубликат по `hash` — ошибка `UNIQUE constraint failed`: слияние записей —
   * дело `memory.write` (задача 005), а хранилище держит инвариант схемы.
   *
   * @param {object} entry — запись.
   * @param {string} entry.kind — тип записи.
   * @param {string} entry.title — заголовок.
   * @param {string} entry.text — полный текст.
   * @param {string} [entry.status] — `draft` | `verified` | `stale`, по умолчанию `draft`.
   * @param {number} [entry.confidence] — уверенность 0..1, по умолчанию 0.
   * @param {string | null} [entry.sourcePath] — файл-источник.
   * @param {string | null} [entry.sourceRef] — коммит/задача/URL.
   * @param {string | null} [entry.author] — кто записал (id сессии или логин).
   * @param {number} [entry.createdAt] — время создания, мс; по умолчанию часы хранилища.
   * @param {number} [entry.updatedAt] — время обновления, мс; по умолчанию `createdAt`.
   * @param {string} [entry.hash] — готовый хэш; по умолчанию считается из полей.
   * @returns {{ id: number, hash: string }} id и хэш вставленной записи.
   */
  insertEntry(entry = {}) {
    const kind = requireString(entry.kind, 'kind')
    const title = requireString(entry.title, 'title')
    const text = requireString(entry.text, 'text')
    const hash = entry.hash === undefined ? entryHash(kind, title, text) : requireString(entry.hash, 'hash')
    const createdAt = entry.createdAt ?? this.#now()
    const updatedAt = entry.updatedAt ?? createdAt

    const info = this.#db
      .prepare(`
        INSERT INTO entries
          (namespace, kind, title, text, status, confidence, source_path, source_ref, author, created_at, updated_at, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        this.#namespace,
        kind,
        title,
        text,
        entry.status ?? 'draft',
        entry.confidence ?? 0,
        entry.sourcePath ?? null,
        entry.sourceRef ?? null,
        entry.author ?? null,
        createdAt,
        updatedAt,
        hash,
      )
    return { id: Number(info.lastInsertRowid), hash }
  }

  /**
   * Найти запись по id в своём namespace.
   *
   * @param {number} id — идентификатор записи.
   * @returns {Record<string, unknown> | null} строка или `null`, в том числе если запись чужая.
   */
  getEntry(id) {
    const row = this.#db.prepare('SELECT * FROM entries WHERE id = ? AND namespace = ?').get(id, this.#namespace)
    return row === undefined ? null : { ...row }
  }

  /**
   * Найти запись по хэшу в своём namespace (основа дедупликации `memory.write`).
   *
   * @param {string} hash — хэш записи.
   * @returns {Record<string, unknown> | null} строка или `null`.
   */
  findEntryByHash(hash) {
    const row = this.#db
      .prepare('SELECT * FROM entries WHERE hash = ? AND namespace = ?')
      .get(requireString(hash, 'hash'), this.#namespace)
    return row === undefined ? null : { ...row }
  }

  /**
   * Полнотекстовый поиск FTS5 (`MATCH`) по своему namespace, сортировка по
   * `bm25` (меньше — лучше). Пустой или невалидный запрос даёт пустой массив:
   * поиск не должен ронять ход (риск из PLAN.md).
   *
   * @param {string} query — запрос FTS5.
   * @param {{ limit?: number }} [options] — сколько записей вернуть.
   * @returns {Array<Record<string, unknown>>} найденные строки с полем `score`.
   */
  searchEntries(query, { limit = DEFAULT_SEARCH_LIMIT } = {}) {
    if (typeof query !== 'string' || query.trim() === '') return []
    const size = Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_SEARCH_LIMIT
    try {
      return this.#db
        .prepare(`
          SELECT entries.*, bm25(entries_fts) AS score
          FROM entries_fts
          JOIN entries ON entries.id = entries_fts.rowid
          WHERE entries_fts MATCH ? AND entries.namespace = ?
          ORDER BY score
          LIMIT ?
        `)
        .all(query, this.#namespace, size)
        .map((row) => ({ ...row }))
    } catch (error) {
      // FTS5 бросает синтаксическую ошибку на «сырой» пользовательский ввод;
      // остальные ошибки (закрытая БД, битый файл) — не повод их глотать.
      if (error?.code === 'ERR_SQLITE_ERROR') return []
      throw error
    }
  }

  /**
   * Обновить поля записи в своём namespace (белый список колонок). Нужно
   * `memory.write` (confidence, провенанс) и будущим `memory.verify` /
   * `memory.invalidate` (status).
   *
   * @param {number} id — идентификатор записи.
   * @param {object} patch — что менять; неизвестные ключи игнорируются.
   * @param {string} [patch.status] — `draft` | `verified` | `stale`.
   * @param {number} [patch.confidence] — уверенность 0..1.
   * @param {string | null} [patch.sourcePath] — основной файл-источник.
   * @param {string | null} [patch.sourceRef] — основной ref источника.
   * @param {number} [patch.updatedAt] — время обновления, мс.
   * @returns {Record<string, unknown> | null} обновлённая строка или `null`, если записи нет в namespace.
   */
  updateEntry(id, patch = {}) {
    const entryId = requireEntryId(id)
    const columns = {
      status: 'status',
      confidence: 'confidence',
      sourcePath: 'source_path',
      sourceRef: 'source_ref',
      updatedAt: 'updated_at',
    }
    const assignments = []
    const values = []
    for (const [key, column] of Object.entries(columns)) {
      if (patch[key] === undefined) continue
      assignments.push(`${column} = ?`)
      values.push(patch[key])
    }
    if (assignments.length === 0) return this.getEntry(entryId)

    const info = this.#db
      .prepare(`UPDATE entries SET ${assignments.join(', ')} WHERE id = ? AND namespace = ?`)
      .run(...values, entryId, this.#namespace)
    return Number(info.changes) === 0 ? null : this.getEntry(entryId)
  }

  /**
   * Добавить провенанс к записи (union по источнику, дубликаты игнорируются).
   * Вызывается после `insertEntry`/`updateEntry`; хранит полный список
   * источников, тогда как `entries.source_path`/`source_ref` — основной.
   *
   * @param {number} entryId — идентификатор записи.
   * @param {ReadonlyArray<{ path?: string, ref?: string }>} sources — источники.
   * @returns {number} сколько новых связей добавлено.
   */
  addEntrySources(entryId, sources = []) {
    const id = requireEntryId(entryId)
    const exists = this.#db.prepare('SELECT 1 AS ok FROM entries WHERE id = ? AND namespace = ?').get(id, this.#namespace)
    if (exists === undefined) {
      throw new Error(`dsh-memory: запись ${id} не найдена в namespace "${this.#namespace}"`)
    }
    const insert = this.#db.prepare('INSERT OR IGNORE INTO entry_sources (entry_id, path, ref) VALUES (?, ?, ?)')
    let added = 0
    for (const source of sources) {
      const info = insert.run(id, source?.path ?? '', source?.ref ?? '')
      added += Number(info.changes)
    }
    return added
  }

  /**
   * Прочитать полный провенанс записи из своего namespace.
   *
   * @param {number} entryId — идентификатор записи.
   * @returns {Array<{ path: string | null, ref: string | null }>} источники в порядке `path`, `ref`.
   */
  listEntrySources(entryId) {
    const id = requireEntryId(entryId)
    return this.#db
      .prepare(`
        SELECT entry_sources.path AS path, entry_sources.ref AS ref
        FROM entry_sources
        JOIN entries ON entries.id = entry_sources.entry_id
        WHERE entries.id = ? AND entries.namespace = ?
        ORDER BY entry_sources.path, entry_sources.ref
      `)
      .all(id, this.#namespace)
      .map((row) => ({ path: row.path === '' ? null : row.path, ref: row.ref === '' ? null : row.ref }))
  }

  /**
   * Записать или обновить источник индексатора (`sources`). Ключ — путь от
   * корня воркспейса: повторная индексация обновляет `sha256`/`mtime`.
   *
   * @param {object} source — источник.
   * @param {string} source.path — путь от корня воркспейса.
   * @param {string} source.sha256 — хэш файла.
   * @param {number} [source.mtime] — время изменения файла, мс; по умолчанию «сейчас».
   * @param {number} [source.indexedAt] — время индексации, мс; по умолчанию «сейчас».
   * @returns {void}
   */
  upsertSource({ path, sha256, mtime, indexedAt } = {}) {
    const now = this.#now()
    this.#db
      .prepare(`
        INSERT INTO sources (path, sha256, indexed_at, mtime)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          sha256 = excluded.sha256,
          indexed_at = excluded.indexed_at,
          mtime = excluded.mtime
      `)
      .run(requireString(path, 'source.path'), requireString(sha256, 'source.sha256'), indexedAt ?? now, mtime ?? now)
  }

  /**
   * Прочитать источник индексатора по пути.
   *
   * @param {string} path — путь от корня воркспейса.
   * @returns {Record<string, unknown> | null} строка `sources` или `null`.
   */
  getSource(path) {
    const row = this.#db.prepare('SELECT * FROM sources WHERE path = ?').get(requireString(path, 'source.path'))
    return row === undefined ? null : { ...row }
  }

  /** Закрыть БД; повторный вызов безопасен. */
  close() {
    if (this.#db.isOpen) this.#db.close()
  }
}

/**
 * Проверить, что значение — непустая строка, и вернуть её.
 *
 * @param {unknown} value — проверяемое значение.
 * @param {string} field — имя поля для сообщения об ошибке.
 * @returns {string} исходная строка.
 */
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`dsh-memory: поле "${field}" должно быть непустой строкой`)
  }
  return value
}

/**
 * Проверить, что значение — идентификатор записи (целое ≥ 1).
 *
 * @param {unknown} value — проверяемое значение.
 * @returns {number} идентификатор.
 */
function requireEntryId(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('dsh-memory: id записи должен быть целым ≥ 1')
  }
  return value
}

/**
 * Привести namespace к безопасному имени файла: `~` уже раскрыт, разделители
 * пути и NUL заменены, ведущие точки не дают имени стать скрытым или `..`.
 *
 * @param {string} namespace — namespace воркспейса.
 * @returns {string} имя файла без расширения.
 */
function namespaceSlug(namespace) {
  return requireString(namespace, 'namespace')
    .replace(/[\\/\0]/g, '_')
    .replace(/^\.+/, '_')
}

/**
 * Раскрыть ведущий `~` в домашний каталог.
 *
 * @param {string} value — путь из конфига.
 * @returns {string} путь без `~`.
 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}
