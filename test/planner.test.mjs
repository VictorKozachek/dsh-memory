/**
 * Тесты контракта planner (задача 026): таймаут, AbortSignal, валидация плана,
 * лимит подтем и fallback на L3 без исключения.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createDispatcher, createRoleRegistry } from '../lib/roles.js'

/** Валидная роль. */
function role(overrides = {}) {
  return {
    name: 'developer',
    prompt: 'Ты разработчик.',
    model: 'cheap',
    namespace: 'demo',
    responsibilities: ['реализация'],
    priority: 20,
    ...overrides,
  }
}

/** Диспетчер с провайдером, который считает вызовы. */
function setup(config = {}) {
  const registry = createRoleRegistry([role()])
  const calls = []
  const dispatcher = createDispatcher({
    registry,
    providers: {
      developer: async ({ subtopic }) => {
        calls.push(subtopic.id)
        return { answer: `ok:${subtopic.text}`, confidence: 0.9 }
      },
    },
    config: { defaultRole: 'developer', ...config },
  })
  return { dispatcher, calls }
}

test('зависший planner не держит ход дольше planTimeoutMs и даёт fallback', async () => {
  const { dispatcher, calls } = setup({ planTimeoutMs: 20 })
  const startedAt = Date.now()
  const result = await dispatcher.dispatch({
    task: 'задача',
    planner: () => new Promise(() => {}),
  })
  assert.equal(result.fallback, true)
  assert.deepEqual(calls, [])
  assert.ok(Date.now() - startedAt < 300, 'planner-таймаут должен быть prompt')
})

test('planner получает AbortSignal; отмена хода не уходит в fallback-ответ', async () => {
  const { dispatcher } = setup()
  const controller = new AbortController()
  let seen = null
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(
    () => dispatcher.dispatch({
      task: 'задача',
      planner: (input) => {
        seen = input.signal
        return new Promise((resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
        })
      },
      signal: controller.signal,
    }),
    (error) => error.name === 'AbortError',
  )
  assert.ok(seen instanceof AbortSignal)
  assert.equal(seen.aborted, true)
})

test('битый план — fallback, а не исключение', async () => {
  const { dispatcher } = setup()
  const cases = [
    { name: 'not array', planner: () => 'плохо' },
    { name: 'number item', planner: () => [42] },
    { name: 'invalid role type', planner: () => [{ id: 'a', text: 'текст', role: 42 }] },
    { name: 'empty string', planner: () => [''] },
    { name: 'empty array', planner: () => [] },
    { name: 'null item', planner: () => [null] },
  ]
  for (const testCase of cases) {
    const result = await dispatcher.dispatch({ task: 'задача', planner: testCase.planner })
    assert.equal(result.fallback, true, testCase.name)
    assert.equal(result.answer, null, testCase.name)
  }
})

test('валидный план из строк и объектов, роль/дефолт подставляются', async () => {
  const { dispatcher, calls } = setup()
  const strings = await dispatcher.dispatch({ task: 'задача', planner: () => ['первая', 'вторая'] })
  assert.equal(strings.fallback, false)
  assert.deepEqual(strings.subtopics.map((item) => item.text), ['первая', 'вторая'])
  assert.ok(strings.subtopics.every((item) => item.role === 'developer'))
  assert.deepEqual(calls, ['s1', 's2'])

  const objects = await dispatcher.dispatch({
    task: 'задача',
    planner: () => [{ id: 'x', text: 'объект', role: 'developer' }],
  })
  assert.equal(objects.fallback, false)
  assert.equal(objects.subtopics[0].id, 'x')
})

test('maxSubtasks ограничивает план и число вызовов ролей', async () => {
  const { dispatcher, calls } = setup({ maxSubtasks: 2 })
  const result = await dispatcher.dispatch({
    task: 'задача',
    planner: () => ['a', 'b', 'c', 'd'],
  })
  assert.equal(result.subtopics.length, 2)
  assert.deepEqual(calls, ['s1', 's2'])

  const explicit = await dispatcher.dispatch({
    task: 'задача',
    subtopics: [
      { id: 'a', text: 'a', role: 'developer' },
      { id: 'b', text: 'b', role: 'developer' },
      { id: 'c', text: 'c', role: 'developer' },
    ],
  })
  assert.equal(explicit.subtopics.length, 2)
})

test('явные subtopics валидируются так же: битый/непустой массив', async () => {
  const { dispatcher } = setup()
  const empty = await dispatcher.dispatch({ task: 'задача', subtopics: [] })
  assert.equal(empty.fallback, true)
  const broken = await dispatcher.dispatch({ task: 'задача', subtopics: [{ text: '', role: 'developer' }] })
  assert.equal(broken.fallback, true)
  const invalidRole = await dispatcher.dispatch({ task: 'задача', subtopics: [{ id: 'a', text: 'x', role: 42 }] })
  assert.equal(invalidRole.fallback, true)
})


test('default_role заполняет отсутствующую role у объекта подтемы', async () => {
  const { dispatcher, calls } = setup()
  const result = await dispatcher.dispatch({
    task: 'задача',
    planner: () => [{ text: 'без роли' }],
  })
  assert.equal(result.fallback, false)
  assert.equal(result.subtopics[0].role, 'developer')
  assert.deepEqual(calls, ['s1'])
})

test('timeout отменяет signal planner (кооперативный planner останавливается)', async () => {
  const { dispatcher } = setup({ planTimeoutMs: 20 })
  let signal
  const result = await dispatcher.dispatch({
    task: 'задача',
    planner: (input) => {
      signal = input.signal
      return new Promise(() => {})
    },
  })
  assert.equal(result.fallback, true)
  assert.ok(signal instanceof AbortSignal)
  assert.equal(signal.aborted, true)
})

test('maxSubtasks пишет warning, а не обрезает план молча', async () => {
  const logs = []
  const registry = createRoleRegistry([role()])
  const dispatcher = createDispatcher({
    registry,
    providers: { developer: async () => ({ answer: 'ok', confidence: 0.9 }) },
    config: { defaultRole: 'developer', maxSubtasks: 2 },
    logger: (level, message) => logs.push(`${level}:${message}`),
  })
  const result = await dispatcher.dispatch({ task: 'задача', planner: () => ['a', 'b', 'c'] })
  assert.equal(result.subtopics.length, 2)
  assert.ok(logs.some((line) => line.includes('max_subtasks')), logs.join('\n'))
})
