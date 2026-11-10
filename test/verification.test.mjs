/**
 * Тесты правила «в память пишем только проверенное» (задача 013):
 * `draft` → `verified` только через `memory.verify` с источником и
 * подтвердителем; запись от модели — `draft` с `confidence ≤ 0.6`.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runCascade } from '../lib/cascade.js'
import { openStore } from '../lib/store.js'
import { verifyMemory } from '../lib/verify.js'
import { writeMemory } from '../lib/write.js'

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0)

/** Открыть хранилище на временном каталоге; закрывается после теста. */
function tempStore(t, namespace = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-verify-'))
  const store = openStore({ dbPath: dir, namespace, now: () => NOW })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

/** Валидная draft-запись от человека. */
function writeDraft(store, overrides = {}) {
  return writeMemory(store, {
    kind: 'fact',
    title: `Знание ${Math.random().toString(16).slice(2)}`,
    text: 'проверенное знание',
    sources: [{ path: 'docs/a.md' }],
    author: 'session-1',
    ...overrides,
  }, { now: () => NOW })
}

test('verified ставится только через memory.verify, с источником и verified_by', (t) => {
  const store = tempStore(t)
  const { id } = writeDraft(store)
  assert.equal(store.getEntry(id).status, 'draft', 'write всегда создаёт draft')

  // memory.write не умеет писать verified напрямую.
  assert.throws(() => writeMemory(store, {
    kind: 'fact',
    title: 'Прямой verified',
    text: 'нельзя',
    status: 'verified',
  }), /пишет только "draft"/)

  // Без verified_by — нельзя.
  assert.throws(() => verifyMemory(store, { id }), /verified_by/)
  // Без источника — нельзя (по умолчанию require_source_for_verified).
  const noSource = store.insertEntry({
    kind: 'fact',
    title: 'Без источника',
    text: 'знание без провенанса',
    status: 'draft',
    confidence: 0.4,
    createdAt: NOW,
    updatedAt: NOW,
  })
  assert.throws(() => verifyMemory(store, { id: noSource.id, verified_by: 'reviewer-1' }), /без источника/)

  // С источником и подтвердителем — можно, и только так.
  assert.deepEqual(verifyMemory(store, { id, verified_by: 'reviewer-1' }, { now: () => NOW + 1 }), {
    id,
    status: 'verified',
  })
  assert.equal(store.getEntry(id).status, 'verified')
  assert.equal(store.getEntry(noSource.id).status, 'draft')
})

test('verify принимает PASS ревью/теста, человека и id сессии, но не произвольную строку', (t) => {
  const store = tempStore(t)
  const accepted = ['human', 'reviewer:session-1', 'verifier:task-013', 'tester-1']
  for (const verifiedBy of accepted) {
    const { id } = writeDraft(store)
    assert.deepEqual(verifyMemory(store, { id, verified_by: verifiedBy }), { id, status: 'verified' }, `не принят ${verifiedBy}`)
  }

  for (const verifiedBy of ['robot', 'x', 'model', 'reviewer:', '7a1c2e9d-0b3f-4c5d-8e6f-9a0b1c2d3e4f']) {
    const { id } = writeDraft(store)
    assert.throws(() => verifyMemory(store, { id, verified_by: verifiedBy }), /verified_by/, `принят ${verifiedBy}`)
    assert.equal(store.getEntry(id).status, 'draft')
  }
})

test('запись каскада (write-back модели) остаётся draft с confidence ≤ 0.6', async (t) => {
  const store = tempStore(t)
  const l2 = await runCascade({
    store,
    query: 'вопрос к L2',
    providers: { l2: () => ({ answer: 'ответ дешёвой модели', sources: [{ ref: 'task/013' }] }) },
    config: { cascade: { enabled: true } },
    now: () => NOW,
  })
  assert.equal(l2.layer, 'L2')
  assert.equal(store.getEntry(l2.entryId).status, 'draft')
  assert.ok(store.getEntry(l2.entryId).confidence <= 0.6)
  assert.equal(store.getEntry(l2.entryId).author, 'cascade:L2')

  const l3 = await runCascade({
    store,
    query: 'вопрос к L3',
    providers: { l2: () => 'NO_ANSWER', l3: () => 'ответ основной модели' },
    config: { cascade: { enabled: true } },
    now: () => NOW,
  })
  assert.equal(l3.layer, 'L3')
  assert.equal(store.getEntry(l3.entryId).status, 'draft')
  assert.ok(store.getEntry(l3.entryId).confidence <= 0.6)

  // Такой draft нельзя верифицировать без источника/подтверждения — как и любой другой.
  assert.throws(() => verifyMemory(store, { id: l3.entryId }), /verified_by/)
})

test('requireSource:false — ручное исключение только для человека', (t) => {
  const store = tempStore(t)
  const humanTarget = store.insertEntry({
    kind: 'fact',
    title: 'Ручное подтверждение',
    text: 'знание без источника',
    status: 'draft',
    confidence: 0.4,
    createdAt: NOW,
    updatedAt: NOW,
  })
  assert.deepEqual(verifyMemory(store, { id: humanTarget.id, verified_by: 'human' }, { requireSource: false }), {
    id: humanTarget.id,
    status: 'verified',
  })

  // PASS ревью/теста без источника не проходит даже с requireSource:false.
  const reviewerTarget = store.insertEntry({
    kind: 'fact',
    title: 'Без источника и ревью',
    text: 'знание без провенанса',
    status: 'draft',
    confidence: 0.4,
    createdAt: NOW,
    updatedAt: NOW,
  })
  assert.throws(
    () => verifyMemory(store, { id: reviewerTarget.id, verified_by: 'reviewer:session-1' }, { requireSource: false }),
    /только "human"/,
  )
  assert.equal(store.getEntry(reviewerTarget.id).status, 'draft')
})
