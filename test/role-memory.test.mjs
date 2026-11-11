/**
 * Тесты namespace/write-back ролей (задача 029): изоляция namespace, author
 * role:<name>, draft ≤ 0.6, verified только через verify, общий namespace по
 * конфигу.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as plugin from '../lib/index.js'

/** Роль. */
function role(name, namespace) {
  return {
    name,
    prompt: `Ты ${name}.`,
    model: 'cheap',
    namespace,
    responsibilities: [name],
    priority: 10,
  }
}

/** Мок ctx + apply, возвращает memory. */
function setup(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-role-memory-'))
  let memory
  const ctx = {
    on: () => {},
    effect: () => {},
    provide: (name, service) => { if (name === 'memory') memory = service },
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
  }
  plugin.apply(ctx, {
    db_path: dir,
    namespace: 'demo',
    dispatcher: { enabled: false, shared_namespace: false, roles: [] },
    ...overrides,
  })
  t.after(() => {
    for (const store of [memory.storeFor(process.cwd()), memory.storeForRole(role('developer', 'role-developer'), process.cwd())]) {
      try { store.close() } catch {}
    }
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, memory }
}

/** Запись роли. */
function input(overrides = {}) {
  return {
    kind: 'fact',
    title: 'Знание роли',
    text: 'уникальный текст знания роли',
    sources: [{ path: 'docs/role.md' }],
    confidence: 1,
    ...overrides,
  }
}

test('writeRole: свой namespace, author role:name, draft ≤ 0.6, поиск только в нём', (t) => {
  const { memory } = setup(t)
  const developer = role('developer', 'role-developer')
  const reviewer = role('reviewer', 'role-reviewer')

  const written = memory.writeRole(developer, input({ title: 'Только разработчик', text: 'альфа-знание разработчика' }))
  assert.equal(written.status, 'draft')
  assert.equal(written.namespace, 'role-developer')
  const entry = memory.storeForRole(developer, process.cwd()).getEntry(written.id)
  assert.equal(entry.author, 'role:developer')
  assert.equal(entry.status, 'draft')
  assert.ok(entry.confidence <= 0.6, `confidence ${entry.confidence}`)

  memory.writeRole(reviewer, input({ title: 'Только ревьювер', text: 'бета-знание ревьювера' }))
  const developerHits = memory.searchRole(developer, { query: 'разработчик' })
  assert.ok(developerHits.some((hit) => hit.id === written.id))
  assert.ok(!developerHits.some((hit) => hit.title === 'Только ревьювер'))
  const reviewerHits = memory.searchRole(reviewer, { query: 'ревьювер' })
  assert.ok(reviewerHits.length > 0)
  assert.ok(!reviewerHits.some((hit) => hit.title === 'Только разработчик'))
  assert.ok(memory.searchRole(developer, { query: 'ревьювер' }).length === 0, 'роль не видит чужой namespace')
})

test('конфликт namespace: одинаковый текст/ids не смешиваются, проектная память чиста', (t) => {
  const { memory } = setup(t)
  const developer = role('developer', 'role-developer')
  const reviewer = role('reviewer', 'role-reviewer')
  const dev = memory.writeRole(developer, input({ title: 'Одинаковый заголовок', text: 'одинаковый текст' }))
  const rev = memory.writeRole(reviewer, input({ title: 'Одинаковый заголовок', text: 'одинаковый текст' }))
  assert.equal(dev.id, 1)
  assert.equal(rev.id, 1)
  assert.equal(memory.storeForRole(developer, process.cwd()).getEntry(1).title, 'Одинаковый заголовок')
  assert.equal(memory.storeForRole(reviewer, process.cwd()).getEntry(1).title, 'Одинаковый заголовок')
  assert.equal(memory.searchSync({ query: 'одинаковый текст' }).length, 0)
})

test('verified недоступен writeRole; verifyRole с reviewer подтверждает, чужой verified_by — нет', (t) => {
  const { memory } = setup(t)
  const developer = role('developer', 'role-developer')
  const written = memory.writeRole(developer, input({ status: 'verified' }))
  assert.equal(written.status, 'draft')

  // writeRole принудительно draft даже при status:verified; verified — только verifyRole.
  assert.equal(memory.writeRole(developer, input({ status: 'verified' })).status, 'draft')
  assert.throws(() => memory.verifyRole(developer, { id: written.id, verified_by: 'session-123' }), /verified_by/)
  const verified = memory.verifyRole(developer, { id: written.id, verified_by: 'reviewer' })
  assert.deepEqual(verified, { id: written.id, status: 'verified' })
})

test('shared_namespace=true: роль пишет в общий namespace и видит проектную память', (t) => {
  const { memory } = setup(t, { dispatcher: { enabled: false, shared_namespace: true, roles: [] } })
  const developer = role('developer', 'role-developer')
  assert.equal(memory.roleNamespace(developer), 'demo')
  const written = memory.writeRole(developer, input({ title: 'Общая', text: 'общее знание' }))
  assert.equal(written.namespace, 'demo')
  assert.ok(memory.searchRole(developer, { query: 'общее знание' }).some((hit) => hit.id === written.id))
  assert.equal(memory.storeFor(process.cwd()).getEntry(written.id).author, 'role:developer')
})
