/**
 * Тесты жизненного цикла записи: `memory.verify` (draft → verified),
 * `memory.invalidate` (stale по path/ref) и TTL при выборке
 * (decision 180 дней, fact 60, answer 30).
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { invalidateMemory } from '../lib/invalidate.js'
import { searchMemory } from '../lib/search.js'
import { openStore } from '../lib/store.js'
import { TTL_DAYS, isExpired, ttlCutoffs, ttlDaysFor } from '../lib/ttl.js'
import { verifyMemory } from '../lib/verify.js'

const DAY = 24 * 60 * 60 * 1_000
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0)

/** Открыть хранилище на временном каталоге; закрывается после теста. */
function tempStore(t, namespace = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-lifecycle-'))
  const store = openStore({ dbPath: dir, namespace, now: () => NOW })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

/** Вставить запись с разумными дефолтами (время фиксировано). */
function add(store, overrides = {}) {
  return store.insertEntry({
    kind: 'fact',
    title: `Запись ${Math.random().toString(16).slice(2)}`,
    text: 'текст записи',
    status: 'draft',
    confidence: 0.5,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  })
}

test('verify переводит draft в verified; повторный verify идемпотентен', (t) => {
  const store = tempStore(t)
  const { id } = add(store, { sourcePath: 'docs/a.md' })

  const result = verifyMemory(store, { id, verified_by: 'reviewer-1' }, { now: () => NOW + 1_000 })
  assert.deepEqual(result, { id, status: 'verified' })
  const entry = store.getEntry(id)
  assert.equal(entry.status, 'verified')
  assert.equal(entry.updated_at, NOW + 1_000)

  assert.deepEqual(verifyMemory(store, { id, verified_by: 'reviewer-1' }), { id, status: 'verified' })
  assert.equal(store.getEntry(id).status, 'verified')
})

test('verify отказывает без verified_by', (t) => {
  const store = tempStore(t)
  const { id } = add(store, { sourcePath: 'docs/a.md' })

  assert.throws(() => verifyMemory(store, { id }), /verified_by/)
  assert.throws(() => verifyMemory(store, { id, verified_by: '   ' }), /verified_by/)
  assert.throws(() => verifyMemory(store, { id, verified_by: 42 }), /verified_by/)
  assert.equal(store.getEntry(id).status, 'draft')
})

test('verify отказывает без источника, но опция requireSource снимает запрет', (t) => {
  const store = tempStore(t)
  const { id } = add(store, {})

  assert.throws(() => verifyMemory(store, { id, verified_by: 'human' }), /без источника/)
  assert.equal(store.getEntry(id).status, 'draft')

  assert.deepEqual(verifyMemory(store, { id, verified_by: 'human' }, { requireSource: false }), { id, status: 'verified' })
})

test('verify видит провенанс из entry_sources', (t) => {
  const store = tempStore(t)
  const { id } = add(store, {})
  store.addEntrySources(id, [{ ref: 'task/005' }])

  assert.deepEqual(verifyMemory(store, { id, verified_by: 'tester' }), { id, status: 'verified' })
})

test('verify не берёт stale и несуществующую запись', (t) => {
  const store = tempStore(t)
  const stale = add(store, { status: 'stale', sourcePath: 'docs/a.md' })

  assert.throws(() => verifyMemory(store, { id: stale.id, verified_by: 'reviewer' }), /stale/)
  assert.throws(() => verifyMemory(store, { id: 999, verified_by: 'reviewer' }), /не найдена/)
  assert.throws(() => verifyMemory(store, { id: 0, verified_by: 'reviewer' }), /id/)
  assert.throws(() => verifyMemory(store, null), /объект/)
})

test('invalidate по path помечает связанные записи stale и считает только новые', (t) => {
  const store = tempStore(t)
  const verified = add(store, { sourcePath: 'docs/a.md', status: 'verified' })
  const draft = add(store, { sourcePath: 'docs/a.md' })
  const other = add(store, { sourcePath: 'docs/b.md', status: 'verified' })

  assert.deepEqual(invalidateMemory(store, { path: 'docs/a.md' }, { now: () => NOW }), { affected: 2 })
  assert.equal(store.getEntry(verified.id).status, 'stale')
  assert.equal(store.getEntry(draft.id).status, 'stale')
  assert.equal(store.getEntry(other.id).status, 'verified')
  assert.equal(store.getEntry(verified.id).updated_at, NOW)

  // Повторная инвалидация уже stale-записей не считает.
  assert.deepEqual(invalidateMemory(store, { path: 'docs/a.md' }), { affected: 0 })
})

test('invalidate по ref находит и source_ref, и entry_sources', (t) => {
  const store = tempStore(t)
  const byRef = add(store, { sourceRef: 'commit:abc', status: 'verified' })
  const linkOnly = add(store, {})
  store.addEntrySources(linkOnly.id, [{ ref: 'commit:abc' }])

  assert.deepEqual(invalidateMemory(store, { ref: 'commit:abc' }), { affected: 2 })
  assert.equal(store.getEntry(byRef.id).status, 'stale')
  assert.equal(store.getEntry(linkOnly.id).status, 'stale')
})

test('invalidate не находит неизвестный источник и требует path/ref', (t) => {
  const store = tempStore(t)
  add(store, { sourcePath: 'docs/a.md' })

  assert.deepEqual(invalidateMemory(store, { path: 'docs/none.md' }), { affected: 0 })
  assert.deepEqual(invalidateMemory(store, { ref: 'none' }), { affected: 0 })

  assert.throws(() => invalidateMemory(store, {}), /path или ref/)
  assert.throws(() => invalidateMemory(store, { path: '   ' }), /path/)
  assert.throws(() => invalidateMemory(store, null), /объект/)
})

test('после invalidate memory.search не находит запись', (t) => {
  const store = tempStore(t)
  const { id } = add(store, {
    kind: 'fact',
    title: 'Инвалидация',
    text: 'уникальное слово зебра',
    status: 'verified',
    sourcePath: 'docs/a.md',
  })

  assert.ok(searchMemory(store, { query: 'зебра' }, { now: () => NOW }).some((result) => result.id === id))
  assert.deepEqual(invalidateMemory(store, { path: 'docs/a.md' }, { now: () => NOW }), { affected: 1 })
  assert.deepEqual(searchMemory(store, { query: 'зебра', status: 'all' }, { now: () => NOW }), [])
})

test('TTL: константы, отсечки и граница', () => {
  assert.deepEqual(TTL_DAYS, { decision: 180, fact: 60, answer: 30 })
  assert.equal(ttlDaysFor('doc'), undefined)
  assert.deepEqual(ttlCutoffs(NOW), {
    decision: NOW - 180 * DAY,
    fact: NOW - 60 * DAY,
    answer: NOW - 30 * DAY,
  })

  assert.equal(isExpired({ kind: 'fact', created_at: NOW - 60 * DAY }, NOW), false)
  assert.equal(isExpired({ kind: 'fact', created_at: NOW - 60 * DAY - 1 }, NOW), true)
  assert.equal(isExpired({ kind: 'doc', created_at: 0 }, NOW), false)
  assert.equal(isExpired({ kind: 'code-note', created_at: 0 }, NOW), false)
})

test('TTL применяется при выборке: 180/60/30 дней, doc не протухает', (t) => {
  const store = tempStore(t)
  const entries = {
    freshFact: add(store, { kind: 'fact', title: 'Факт свежий', text: 'маркер ттл свежий', status: 'verified', createdAt: NOW - 59 * DAY }),
    oldFact: add(store, { kind: 'fact', title: 'Факт старый', text: 'маркер ттл старый', status: 'verified', createdAt: NOW - 61 * DAY }),
    freshDecision: add(store, { kind: 'decision', title: 'Решение свежее', text: 'маркер ттл решение свежее', status: 'verified', createdAt: NOW - 179 * DAY }),
    oldDecision: add(store, { kind: 'decision', title: 'Решение старое', text: 'маркер ттл решение старое', status: 'verified', createdAt: NOW - 181 * DAY }),
    freshAnswer: add(store, { kind: 'answer', title: 'Ответ свежий', text: 'маркер ттл ответ свежий', status: 'verified', createdAt: NOW - 29 * DAY }),
    oldAnswer: add(store, { kind: 'answer', title: 'Ответ старый', text: 'маркер ттл ответ старый', status: 'verified', createdAt: NOW - 31 * DAY }),
    oldDoc: add(store, { kind: 'doc', title: 'Документ', text: 'маркер ттл документ', status: 'verified', createdAt: NOW - 1_000 * DAY }),
  }

  const results = searchMemory(store, { query: 'маркер ттл', status: 'all', k: 20 }, { now: () => NOW })
  const ids = results.map((result) => result.id)

  for (const key of ['freshFact', 'freshDecision', 'freshAnswer', 'oldDoc']) {
    assert.ok(ids.includes(entries[key].id), `${key} должен быть найден`)
  }
  for (const key of ['oldFact', 'oldDecision', 'oldAnswer']) {
    assert.ok(!ids.includes(entries[key].id), `${key} просрочен и не должен быть найден`)
  }
  assert.equal(results.length, 4)
})
