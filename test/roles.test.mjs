/**
 * Тесты реестра ролей и прототипа диспетчера (задача 018): валидация, порядок,
 * маршрутизация подтем на моках, агрегация/конфликты, ошибки/таймауты,
 * отмена, planner.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ROLE_NAMES,
  aggregateResults,
  createDispatcher,
  createRoleRegistry,
  validateRole,
} from '../lib/roles.js'

/** Валидная роль с переопределениями. */
function role(overrides = {}) {
  return {
    name: 'developer',
    prompt: 'Ты разработчик проекта.',
    model: 'deepseek-v4-flash',
    namespace: 'project-memory',
    responsibilities: ['реализация', 'отладка'],
    priority: 20,
    ...overrides,
  }
}

/** Реестр из трёх ролей. */
function registry() {
  return createRoleRegistry([
    role({ name: 'developer', priority: 20 }),
    role({ name: 'reviewer', prompt: 'Ты ревьювер.', responsibilities: ['ревью'], priority: 10 }),
    role({ name: 'tester', prompt: 'Ты тестировщик.', responsibilities: ['тесты'], priority: 10 }),
  ])
}

test('validateRole: обязательные поля, имя, priority; ROLE_NAMES из README', () => {
  const valid = validateRole(role())
  assert.equal(valid.name, 'developer')
  assert.deepEqual(valid.responsibilities, ['реализация', 'отладка'])
  assert.equal(valid.priority, 20)
  assert.equal(valid.enabled, true)
  assert.deepEqual(ROLE_NAMES, ['developer', 'designer', 'reviewer', 'tester', 'scientist'])

  assert.throws(() => validateRole(role({ name: 'Developer' })), /имя роли/)
  assert.throws(() => validateRole(role({ prompt: '  ' })), /prompt/)
  assert.throws(() => validateRole(role({ model: '' })), /model/)
  assert.throws(() => validateRole(role({ namespace: '' })), /namespace/)
  assert.throws(() => validateRole(role({ priority: -1 })), /priority/)
  assert.throws(() => validateRole(null), /объектом/)
})

test('реестр: уникальность и детерминированный порядок по priority/name', () => {
  const roles = registry()
  assert.equal(roles.size, 3)
  assert.deepEqual(roles.list().map((item) => item.name), ['reviewer', 'tester', 'developer'])
  assert.equal(roles.get('reviewer').prompt, 'Ты ревьювер.')
  assert.equal(roles.get('unknown'), null)
  assert.throws(() => roles.add(role()), /уже зарегистрирована/)
})

test('dispatch маршрутизирует подтемы ролям и передаёт namespace/промпт', async () => {
  const roles = registry()
  const calls = []
  const dispatcher = createDispatcher({
    registry: roles,
    providers: {
      developer: async ({ role: roleInfo, subtopic }) => {
        calls.push(['developer', subtopic.id, roleInfo.namespace])
        return { answer: `код: ${subtopic.text}`, confidence: 0.8, sources: ['src/app.js'] }
      },
      reviewer: async ({ role: roleInfo, subtopic }) => {
        calls.push(['reviewer', subtopic.id, roleInfo.namespace])
        return { answer: `ревью: ${subtopic.text}`, confidence: 0.9, sources: ['review/1'] }
      },
    },
  })

  const result = await dispatcher.dispatch({
    task: 'сделать фичу',
    subtopics: [
      { id: 'a', text: 'реализовать API', role: 'developer' },
      { id: 'b', text: 'проверить API', role: 'reviewer' },
    ],
  })
  assert.equal(result.fallback, false)
  assert.deepEqual(calls, [
    ['developer', 'a', 'project-memory'],
    ['reviewer', 'b', 'project-memory'],
  ])
  assert.equal(result.answers.length, 2)
  assert.deepEqual(result.results.map((item) => item.role).sort(), ['developer', 'reviewer'])
  assert.match(result.answer, /код: реализовать API/)
  assert.match(result.answer, /ревью: проверить API/)
})

test('planner на моках: подтемы и маршрутизация по responsibilities', async () => {
  const roles = registry()
  const calls = []
  const dispatcher = createDispatcher({
    registry: roles,
    providers: {
      developer: async ({ subtopic }) => { calls.push(subtopic.text); return { answer: 'dev', confidence: 0.8 } },
      tester: async ({ subtopic }) => { calls.push(subtopic.text); return { answer: 'test', confidence: 0.8 } },
    },
  })
  const planner = () => [
    { id: 's1', text: 'реализация API', role: 'developer' },
    { id: 's2', text: 'тесты API', role: 'tester' },
  ]
  const result = await dispatcher.dispatch({ task: 'задача', planner })
  assert.deepEqual(calls.sort(), ['реализация API', 'тесты API'])
  assert.equal(result.fallback, false)
})

test('агрегация: priority/confidence/sources/vote/concat и конфликты', () => {
  const dev = { role: 'developer', answer: 'вариант A', confidence: 0.9, sources: [], priority: 20 }
  const rev = { role: 'reviewer', answer: 'вариант B', confidence: 0.7, sources: ['review/1'], priority: 10 }
  const tie = { role: 'tester', answer: 'вариант A', confidence: 0.7, sources: [], priority: 10 }

  assert.equal(aggregateResults([dev, rev], { strategy: 'priority' }).role, 'reviewer')
  assert.equal(aggregateResults([dev, rev], { strategy: 'priority' }).answer, 'вариант B')
  assert.deepEqual(aggregateResults([dev, rev], { strategy: 'priority' }).conflicts, ['вариант a', 'вариант b'])
  assert.equal(aggregateResults([dev, tie], { strategy: 'vote' }).answer, 'вариант A')
  assert.equal(aggregateResults([dev, rev], { strategy: 'concat' }).answer, '[developer] вариант A\n\n[reviewer] вариант B')

  const empty = aggregateResults([{ role: 'developer', answer: '' }])
  assert.equal(empty.fallback, true)
  assert.equal(empty.answer, null)
})

test('ошибка/таймаут роли не роняет остальные, все failed → fallback L3', async () => {
  const roles = registry()
  const dispatcher = createDispatcher({
    registry: roles,
    config: { timeout_ms: 20 },
    providers: {
      developer: async () => { throw new Error('provider down') },
      reviewer: async () => new Promise(() => {}),
    },
  })
  const partial = await dispatcher.dispatch({
    task: 'задача',
    subtopics: [
      { id: 'a', text: 'код', role: 'developer' },
      { id: 'b', text: 'ревью', role: 'reviewer' },
    ],
  })
  assert.equal(partial.fallback, true)

  const withTester = createDispatcher({
    registry: roles,
    config: { timeout_ms: 20 },
    providers: {
      developer: async () => ({ answer: 'ok', confidence: 0.8 }),
      reviewer: async () => { throw new Error('down') },
    },
  }).dispatch({
    task: 'задача',
    subtopics: [
      { id: 'a', text: 'код', role: 'developer' },
      { id: 'b', text: 'ревью', role: 'reviewer' },
    ],
  })
  const result = await withTester
  assert.equal(result.fallback, false)
  assert.equal(result.answers.length, 1)
})

test('неизвестная/выключенная роль и отсутствующий provider → fallback', async () => {
  const roles = registry()
  const dispatcher = createDispatcher({ registry: roles, providers: {} })
  const result = await dispatcher.dispatch({
    task: 'задача',
    subtopics: [
      { id: 'a', text: 'код', role: 'unknown' },
      { id: 'b', text: 'ревью', role: 'reviewer' },
    ],
  })
  assert.equal(result.fallback, true)
  assert.equal(result.results.filter((item) => item.error).length, 2)
})

test('отмена хода не вызывает провайдеров и даёт AbortError', async () => {
  const roles = registry()
  const controller = new AbortController()
  const called = []
  const dispatcher = createDispatcher({
    registry: roles,
    providers: { developer: async () => { called.push('developer'); return { answer: 'x' } } },
  })
  controller.abort()
  await assert.rejects(
    () => dispatcher.dispatch({ task: 'задача', subtopics: [{ id: 'a', text: 'код', role: 'developer' }], signal: controller.signal }),
    (error) => error.name === 'AbortError',
  )
  assert.deepEqual(called, [])
})

test('диспетчер без валидного плана/реестра ведёт себя предсказуемо', async () => {
  const roles = registry()
  const dispatcher = createDispatcher({ registry: roles, config: { defaultRole: 'developer' }, providers: { developer: async () => ({ answer: 'ok' }) } })
  const direct = await dispatcher.dispatch({ task: 'просто задача' })
  assert.equal(direct.fallback, false)
  assert.equal(direct.role, 'developer')

  const emptyDispatcher = createDispatcher({ registry: createRoleRegistry([]), providers: {} })
  const empty = await emptyDispatcher.dispatch({ task: 'задача' })
  assert.equal(empty.fallback, true)

  assert.throws(() => createDispatcher({}), /реестр/)
  await assert.rejects(() => dispatcher.dispatch({ task: '   ' }), /task/)
})
