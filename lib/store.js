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

import { stemText } from './stemmer.js'

/** Сколько записей `searchEntries` отдаёт, если `limit` не задан. */
const DEFAULT_SEARCH_LIMIT = 10

/** Таймаут ожидания блокировки БД по умолчанию. */
const DEFAULT_BUSY_TIMEOUT_MS = 5_000

/** Допустимые статусы записи (спека §5.1). */
export const ENTRY_STATUSES = Object.freeze(['draft', 'verified', 'stale'])

/** Версия схемы: растёт вместе с {@link MIGRATIONS}. */
export const SCHEMA_VERSION = 3

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
    version: 3,
    name: 'lexical indexes: stemmed unicode61 + trigram',
    sql: `
      ALTER TABLE entries ADD COLUMN title_lex TEXT NOT NULL DEFAULT '';
      ALTER TABLE entries ADD COLUMN text_lex TEXT NOT NULL DEFAULT '';
      UPDATE entries SET title_lex = lower(title), text_lex = lower(text);

      CREATE VIRTUAL TABLE entries_fts_lex USING fts5(
        title_lex,
        text_lex,
        content='entries',
        content_rowid='id'
      );

      INSERT INTO entries_fts_lex(entries_fts_lex) VALUES ('rebuild');

      CREATE TRIGGER entries_fts_lex_insert AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts_lex(rowid, title_lex, text_lex)
          VALUES (new.id, new.title_lex, new.text_lex);
      END;

      CREATE TRIGGER entries_fts_lex_delete AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts_lex(entries_fts_lex, rowid, title_lex, text_lex)
          VALUES ('delete', old.id, old.title_lex, old.text_lex);
      END;

      CREATE TRIGGER entries_fts_lex_update AFTER UPDATE ON entries BEGIN
        INSERT INTO entries_fts_lex(entries_fts_lex, rowid, title_lex, text_lex)
          VALUES ('delete', old.id, old.title_lex, old.text_lex);
        INSERT INTO entries_fts_lex(rowid, title_lex, text_lex)
          VALUES (new.id, new.title_lex, new.text_lex);
      END;

      CREATE VIRTUAL TABLE entries_fts_trigram USING fts5(
        title,
        text,
        content='entries',
        content_rowid='id',
        tokenize='trigram'
      );

      INSERT INTO entries_fts_trigram(entries_fts_trigram) VALUES ('rebuild');

      CREATE TRIGGER entries_fts_trigram_insert AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts_trigram(rowid, title, text) VALUES (new.id, new.title, new.text);
      END;

      CREATE TRIGGER entries_fts_trigram_delete AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts_trigram(entries_fts_trigram, rowid, title, text)
          VALUES ('delete', old.id, old.title, old.text);
      END;

      CREATE TRIGGER entries_fts_trigram_update AFTER UPDATE ON entries BEGIN
        INSERT INTO entries_fts_trigram(entries_fts_trigram, rowid, title, text)
          VALUES ('delete', old.id, old.title, old.text);
        INSERT INTO entries_fts_trigram(rowid, title, text) VALUES (new.id, new.title, new.text);
      END;
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
  try {
    return new MemoryStore(db, { namespace, file, now })
  } catch (error) {
    // Схема уже смигрирована, но конструктор мог упасть на backfill: держать
    // дескриптор открытым нельзя, иначе файл останется заблокированным.
    db.close()
    throw error
  }
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
  for (const migration of [...MIGRATIONS].sort((left, right) => left.version - right.version)) {
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
    this.#backfillLexIndex()
  }

  /**
   * Дозаполнить `title_lex`/`text_lex` для записей, созданных до миграции 3
   * (или вставленных в обход `insertEntry`). Идёт один раз при открытии и
   * синхронизирует FTS-триггеры обновлением строк.
   *
   * @returns {void}
   */
  #backfillLexIndex() {
    // Миграция 3 заполняет лексические колонки lower(title/text) и строит по ним
    // индекс (валидный, но без стемминга). Здесь доводим до Snowball-основ; для
    // свежих строк insertEntry уже пишет основы и UPDATE не нужен.
    const rows = this.#db
      .prepare('SELECT id, title, text, title_lex, text_lex FROM entries')
      .all()
    if (rows.length === 0) return
    const update = this.#db.prepare('UPDATE entries SET title_lex = ?, text_lex = ? WHERE id = ?')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const titleLex = stemText(row.title)
        const textLex = stemText(row.text)
        if (titleLex !== row.title_lex || textLex !== row.text_lex) {
          update.run(titleLex, textLex, row.id)
        }
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
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
          (namespace, kind, title, text, title_lex, text_lex, status, confidence, source_path, source_ref, author, created_at, updated_at, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        this.#namespace,
        kind,
        title,
        text,
        stemText(title),
        stemText(text),
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
   * `bm25` (меньше — лучше). `stale` не возвращается никогда; `kinds`,
   * `status: "verified"` и TTL (`expiresBefore`) сужают выборку. Пустой или
   * синтаксически невалидный запрос даёт пустой массив (поиск не должен ронять
   * ход), а поломка БД (например, нет таблицы FTS) — исключение: её нельзя
   * выдавать за «ничего не найдено».
   *
   * @param {string} query — запрос FTS5.
   * @param {object} [options] — фильтры.
   * @param {number} [options.limit] — топ-k.
   * @param {readonly string[]} [options.kinds] — только эти `kind`.
   * @param {'verified' | 'all'} [options.status] — `verified` — только проверенные.
   * @param {Record<string, number>} [options.expiresBefore] — TTL: для указанных `kind` запись живёт, пока `created_at > cutoff` (мс).
   * @returns {Array<Record<string, unknown>>} найденные строки с полем `score`.
   */
  searchEntries(query, options = {}) {
    return this.#searchFts('entries_fts', query, options)
  }

  /**
   * Лексический поиск по стеммированному индексу (`entries_fts_lex`, задача 020).
   * Запрос должен быть уже собран из основ (Snowball/мягкие основы/синонимы).
   *
   * @param {string} query — FTS5-запрос по основам.
   * @param {object} [options] — те же фильтры, что у `searchEntries`.
   * @returns {Array<Record<string, unknown>>} строки с `score` (bm25).
   */
  searchLex(query, options = {}) {
    return this.#searchFts('entries_fts_lex', query, options)
  }

  /**
   * Поиск по trigram-индексу (`entries_fts_trigram`, задача 020): переживает
   * опечатки и подстроки. Запрос — OR триграмм; окончательный ранжир делает
   * вызывающий слой по similarity.
   *
   * @param {string} query — FTS5-запрос из триграмм.
   * @param {object} [options] — те же фильтры, что у `searchEntries`.
   * @returns {Array<Record<string, unknown>>} строки с `score` (bm25).
   */
  searchTrigram(query, options = {}) {
    return this.#searchFts('entries_fts_trigram', query, options)
  }

  /**
   * Отдельный канал Q&A: `verified`-записи `kind = 'answer'`, в заголовке
   * которых встречается запрос (задача 020). Точное совпадение заголовка идёт
   * первым; общий ранжир/скор назначает `memory.search`.
   *
   * @param {string} query — запрос (сравнивается без регистра).
   * @param {{ limit?: number }} [options] — предел.
   * @returns {Array<Record<string, unknown>>} записи с `title_rank` (0 — точное совпадение).
   */
  searchVerifiedAnswersByTitle(query, { limit = 5 } = {}) {
    if (typeof query !== 'string' || query.trim() === '') return []
    const size = Number.isSafeInteger(limit) && limit > 0 ? limit : 5
    const normalized = query.trim().toLowerCase()
    // SQLite lower() не складывает кириллицу, поэтому сравнение делаем в JS:
    // verified-ответов немного, а `%`/`_` в запросе не должны быть LIKE-шаблоном.
    return this.#db
      .prepare(`
        SELECT entries.*
        FROM entries
        WHERE entries.namespace = ? AND entries.status = 'verified' AND entries.kind = 'answer'
        ORDER BY entries.updated_at DESC
      `)
      .all(this.#namespace)
      .filter((row) => String(row.title).toLowerCase().includes(normalized))
      .sort((left, right) => {
        const leftRank = String(left.title).toLowerCase() === normalized ? 0 : 1
        const rightRank = String(right.title).toLowerCase() === normalized ? 0 : 1
        return leftRank - rightRank || Number(right.updated_at) - Number(left.updated_at)
      })
      .slice(0, size)
      .map((row) => ({ ...row, title_rank: String(row.title).toLowerCase() === normalized ? 0 : 1 }))
  }

  /**
   * Общий FTS-запрос по указанной таблице (raw/lex/trigram).
   *
   * @param {'entries_fts' | 'entries_fts_lex' | 'entries_fts_trigram'} table — FTS-таблица.
   * @param {string} query — MATCH-запрос.
   * @param {object} [options] — фильтры.
   * @returns {Array<Record<string, unknown>>} строки с `score`.
   */
  #searchFts(table, query, { limit = DEFAULT_SEARCH_LIMIT, kinds, status, expiresBefore } = {}) {
    if (typeof query !== 'string' || query.trim() === '') return []
    const size = Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_SEARCH_LIMIT
    const params = [query, this.#namespace]
    let sql = `
      SELECT entries.*, bm25(${table}) AS score
      FROM ${table}
      JOIN entries ON entries.id = ${table}.rowid
      WHERE ${table} MATCH ? AND entries.namespace = ? AND entries.status != 'stale'
    `
    if (status === 'verified') sql += " AND entries.status = 'verified'"
    if (Array.isArray(kinds) && kinds.length > 0) {
      sql += ` AND entries.kind IN (${kinds.map(() => '?').join(', ')})`
      params.push(...kinds)
    }
    if (expiresBefore !== null && typeof expiresBefore === 'object') {
      const cutoffs = Object.entries(expiresBefore).filter(([, cutoff]) => Number.isFinite(cutoff))
      if (cutoffs.length > 0) {
        sql += ` AND (CASE entries.kind ${cutoffs.map(() => 'WHEN ? THEN entries.created_at > ?').join(' ')} ELSE 1 END)`
        for (const [kind, cutoff] of cutoffs) params.push(kind, cutoff)
      }
    }
    sql += ' ORDER BY score LIMIT ?'
    params.push(size)

    try {
      return this.#db.prepare(sql).all(...params).map((row) => ({ ...row }))
    } catch (error) {
      if (isFtsQueryError(error)) return []
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
    validateEntryPatch(patch)
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
   * Пометить `stale` записи своего namespace, связанные с источником: путь
   * (`entries.source_path` или `entry_sources.path`) или ref (`entries.source_ref`
   * или `entry_sources.ref`). Уже stale записи повторно не считаются — возврат
   * равен числу записей, которые стали stale этим вызовом. Нужно
   * `memory.invalidate` (задача 006).
   *
   * @param {{ path?: string | null, ref?: string | null }} source — что инвалидировать; нужен хотя бы один.
   * @param {number} [updatedAt] — время изменения, мс; по умолчанию часы хранилища.
   * @returns {number} сколько записей стало stale.
   */
  invalidateBySource({ path = null, ref = null } = {}, updatedAt) {
    const sourcePath = path === null || path === undefined ? null : requireString(path, 'path')
    const sourceRef = ref === null || ref === undefined ? null : requireString(ref, 'ref')
    if (sourcePath === null && sourceRef === null) {
      throw new TypeError('dsh-memory: invalidate нужен path или ref')
    }
    const info = this.#db
      .prepare(`
        UPDATE entries SET status = 'stale', updated_at = ?
        WHERE namespace = ? AND status != 'stale' AND (
          (? IS NOT NULL AND source_path = ?)
          OR (? IS NOT NULL AND source_ref = ?)
          OR id IN (
            SELECT entry_sources.entry_id FROM entry_sources
            WHERE (? IS NOT NULL AND entry_sources.path = ?)
               OR (? IS NOT NULL AND entry_sources.ref = ?)
          )
        )
      `)
      .run(
        updatedAt ?? this.#now(),
        this.#namespace,
        sourcePath,
        sourcePath,
        sourceRef,
        sourceRef,
        sourcePath,
        sourcePath,
        sourceRef,
        sourceRef,
      )
    return Number(info.changes)
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

  /**
   * Все источники индексатора (задача 014): по ним находится исчезнувший файл.
   *
   * @returns {Array<Record<string, unknown>>} строки `sources`, отсортированы по пути.
   */
  listSources() {
    return this.#db.prepare('SELECT * FROM sources ORDER BY path').all().map((row) => ({ ...row }))
  }

  /**
   * Удалить источник индексатора (файл удалён/исключён из обхода).
   *
   * @param {string} path — путь от корня воркспейса.
   * @returns {boolean} true, если строка была.
   */
  deleteSource(path) {
    const info = this.#db.prepare('DELETE FROM sources WHERE path = ?').run(requireString(path, 'source.path'))
    return Number(info.changes) > 0
  }

  /**
   * Пометить чанки индексатора по файлу `stale` (задача 014). Записи
   * `memory.write` с тем же `source_path` не трогаются — у них свой жизненный
   * цикл (`memory.invalidate`), а индексатор отвечает только за свои чанки.
   *
   * @param {string} sourcePath — путь от корня воркспейса.
   * @param {number} [updatedAt] — время пометки, мс; по умолчанию часы хранилища.
   * @returns {number} сколько чанков переведено в `stale`.
   */
  staleIndexedChunks(sourcePath, updatedAt) {
    const info = this.#db
      .prepare("UPDATE entries SET status = 'stale', updated_at = ? WHERE namespace = ? AND source_path = ? AND author = 'indexer' AND status != 'stale'")
      .run(updatedAt ?? this.#now(), this.#namespace, requireString(sourcePath, 'sourcePath'))
    return Number(info.changes)
  }

  /**
   * Записать событие в `metrics` (задача 007). `payload` сериализуется в JSON:
   * схема §5.1 хранит `event` и `payload`, а поля события (query_hash, hits,
   * latency_ms и т.п.) — внутри payload.
   *
   * @param {string} event — тип события (`search`, `write`, `verify`, `route`).
   * @param {Record<string, unknown>} [payload] — данные события.
   * @param {number} [ts] — время события, мс; по умолчанию часы хранилища.
   * @returns {void}
   */
  recordMetric(event, payload = {}, ts) {
    this.#db
      .prepare('INSERT INTO metrics (ts, event, payload) VALUES (?, ?, ?)')
      .run(ts ?? this.#now(), requireString(event, 'event'), JSON.stringify(payload ?? {}))
  }

  /**
   * Прочитать события `metrics` в порядке записи. Битый JSON в payload не роняет
   * чтение (payload = null): таблица может содержать старые/ручные строки.
   *
   * @param {{ event?: string }} [options] — фильтр по типу события.
   * @returns {Array<{ ts: number, event: string, payload: Record<string, unknown> | null }>} события.
   */
  listMetrics({ event } = {}) {
    const rows = event === undefined
      ? this.#db.prepare('SELECT ts, event, payload FROM metrics ORDER BY ts, rowid').all()
      : this.#db.prepare('SELECT ts, event, payload FROM metrics WHERE event = ? ORDER BY ts, rowid').all(requireString(event, 'event'))
    return rows.map((row) => ({ ts: Number(row.ts), event: row.event, payload: parseMetricPayload(row.payload) }))
  }

  /**
   * Сколько записей в namespace (все статусы).
   *
   * @returns {number} число записей.
   */
  countEntries() {
    return Number(this.#db.prepare('SELECT count(*) AS n FROM entries WHERE namespace = ?').get(this.#namespace).n)
  }

  /**
   * Сколько записей в namespace по статусам.
   *
   * @returns {Array<{ status: string, count: number }>} счётчики по статусам (только непустые).
   */
  countEntriesByStatus() {
    return this.#db
      .prepare('SELECT status, count(*) AS n FROM entries WHERE namespace = ? GROUP BY status')
      .all(this.#namespace)
      .map((row) => ({ status: row.status, count: Number(row.n) }))
  }

  /**
   * Удалить чанки индексатора для источника (`source_path`). Предикат узкий —
   * `kind = 'doc' AND author = 'indexer'`: записи `memory.write` с тем же
   * `source_path` (провенанс, задача 005) при переиндексации файла обязаны
   * выжить, терять `verified`-факты нельзя.
   *
   * Нужно индексатору: при изменении файла старые чанки уходят, чтобы не
   * нарушать `UNIQUE(hash)` и не оставлять сирот. TTL/`stale` — задача 014;
   * здесь замена версии файла.
   *
   * @param {string} sourcePath — путь от корня воркспейса.
   * @returns {number} сколько чанков удалено.
   */
  deleteIndexedChunks(sourcePath) {
    const info = this.#db
      .prepare("DELETE FROM entries WHERE namespace = ? AND source_path = ? AND kind = 'doc' AND author = 'indexer'")
      .run(this.#namespace, requireString(sourcePath, 'sourcePath'))
    return Number(info.changes)
  }

  /**
   * Выполнить синхронную операцию в транзакции: `COMMIT` при успехе,
   * `ROLLBACK` при любой ошибке. Нужно индексатору, чтобы замена чанков файла
   * (удаление старых → вставка новых → отметка источника) была атомарной и
   * сбой не оставлял файл без индекса.
   *
   * @template T
   * @param {() => T} callback — работа внутри транзакции.
   * @returns {T} результат `callback`.
   */
  transaction(callback) {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK')
      } catch {
        // Транзакцию уже откатило SQLite — исходная ошибка важнее.
      }
      throw error
    }
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
 * Проверить поля `updateEntry` (контракт для `memory.write`/`verify`/
 * `invalidate`): статус из списка, confidence 0..1, провенанс — строка/null.
 *
 * @param {unknown} patch — объект изменений.
 * @returns {void}
 */
function validateEntryPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('dsh-memory: updateEntry ждёт объект изменений')
  }
  if (patch.status !== undefined && !ENTRY_STATUSES.includes(patch.status)) {
    throw new TypeError(`dsh-memory: status должен быть одним из ${ENTRY_STATUSES.join(', ')}; получено "${patch.status}"`)
  }
  if (patch.confidence !== undefined
    && (typeof patch.confidence !== 'number' || !Number.isFinite(patch.confidence) || patch.confidence < 0 || patch.confidence > 1)) {
    throw new TypeError('dsh-memory: confidence должна быть числом 0..1')
  }
  for (const field of ['sourcePath', 'sourceRef']) {
    const value = patch[field]
    if (value !== undefined && value !== null && (typeof value !== 'string' || value.trim() === '')) {
      throw new TypeError(`dsh-memory: ${field} должен быть непустой строкой или null`)
    }
  }
  if (patch.updatedAt !== undefined && (!Number.isSafeInteger(patch.updatedAt) || patch.updatedAt < 0)) {
    throw new TypeError('dsh-memory: updatedAt должен быть целым ≥ 0')
  }
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

/**
 * Синтаксическая ли ошибка FTS5-запроса. Только такие ошибки хранилище
 * превращает в пустой результат; «no such table: entries_fts» или закрытая БД
 * — это поломка БД, её проглатывать нельзя. `no such column: X` — тоже ошибка
 * запроса: так FTS5 реагирует на `dsh-memory` (column filter), а не на поломку.
 *
 * @param {unknown} error — ошибка из `node:sqlite`.
 * @returns {boolean} true для ошибки синтаксиса MATCH.
 */
function isFtsQueryError(error) {
  if (error?.code !== 'ERR_SQLITE_ERROR') return false
  return /^(fts5: syntax error|unterminated string|unknown special query|no such column)/i.test(String(error.message ?? ''))
}

/**
 * Разобрать JSON-payload метрики. Битые строки (ручные вставки, старая схема)
 * дают null: чтение статистики не должно падать из-за одной строки.
 *
 * @param {unknown} raw — значение колонки `payload`.
 * @returns {Record<string, unknown> | null} объект или null.
 */
function parseMetricPayload(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}
