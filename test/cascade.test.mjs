/**
 * Тесты мягкого каскада (задача 012): пресет `triage`, правило L1 → L2 → L3,
 * write-back `draft` с источником и route-метрики. Провайдеры моделей —
 * моки, поэтому тест проверяет, что при попадании в память L3 не вызывается.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadCascadePreset, resolveCascade, runCascade } from '../lib/cascade.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { memoryStats } from '../lib/metrics.js'
import { openStore } from '../lib/store.js'

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0)

/** Открыть хранилище на временном каталоге; закрывается после теста. */
function tempStore(t, namespace = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-cascade-'))
  const store = openStore({ dbPath: dir, namespace, now: () => NOW })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

/** Записать verified-знание, которое найдёт L1. */
function seedMemory(store) {
  return store.insertEntry({
    kind: 'fact',
    title: 'Память проекта',
    text: 'память проекта хранит проверенные знания между сессиями',
    status: 'verified',
    confidence: 1,
    sourcePath: 'docs/memory.md',
    createdAt: NOW,
    updatedAt: NOW,
  })
}

test('пресет triage описан и перекрывается конфигом', () => {
  const preset = loadCascadePreset('triage')
  assert.equal(preset.id, 'triage')
  assert.equal(preset.layer, 'L2')
  assert.deepEqual(preset.contract, { answer: 'ANSWER', noAnswer: 'NO_ANSWER' })
  assert.equal(preset.model, 'deepseek-v4-flash')
  assert.equal(preset.maxTokens, 300)
  assert.equal(typeof preset.provider, 'string')

  const resolved = resolveCascade({ cascade: { enabled: true, model: 'cheap-model', max_tokens: 120 } })
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.writeBack, true)
  assert.equal(resolved.preset.model, 'cheap-model')
  assert.equal(resolved.preset.maxTokens, 120)

  assert.throws(() => loadCascadePreset('unknown'), /неизвестный пресет/)
  assert.deepEqual(DEFAULT_CONFIG.cascade, {
    enabled: false,
    preset: 'triage',
    model: '',
    max_tokens: 300,
    write_back: true,
  })
})

test('попадание в память (L1): L2/L3 не вызываются, route L1 без экономии', async (t) => {
  const store = tempStore(t)
  const hit = seedMemory(store)
  const calls = []
  const providers = {
    l2: () => {
      calls.push('l2')
      return 'ответ L2'
    },
    l3: () => {
      calls.push('l3')
      return 'ответ L3'
    },
  }

  const result = await runCascade({
    store,
    query: 'память проекта',
    providers,
    config: { cascade: { enabled: true } },
    now: () => NOW,
  })

  assert.equal(result.layer, 'L1')
  assert.equal(result.entryId, hit.id)
  assert.equal(result.wroteBack, false)
  assert.match(result.answer, /память проекта/)
  assert.deepEqual(calls, [], 'при попадании в память модели вызываться не должны')

  const [route] = store.listMetrics({ event: 'route' })
  assert.equal(route.payload.layer, 'L1')
  assert.equal(route.payload.tokens_saved_estimate, 0)
  assert.equal(route.payload.injected_tokens, 0)
})

test('L2 (triage) отвечает: L3 не вызывается, ответ пишется draft с источником', async (t) => {
  const store = tempStore(t)
  const calls = []
  let seenPreset
  const providers = {
    l2: ({ preset }) => {
      calls.push('l2')
      seenPreset = preset
      return {
        status: 'ANSWER',
        answer: 'короткий ответ дешёвой модели',
        sources: [{ ref: 'task/012' }],
        tokensSavedEstimate: 500,
      }
    },
    l3: () => {
      calls.push('l3')
      return 'ответ основной'
    },
  }

  const result = await runCascade({
    store,
    query: 'как устроена память проекта?',
    providers,
    config: { cascade: { enabled: true, model: 'cheap-model' } },
    now: () => NOW,
  })

  assert.equal(result.layer, 'L2')
  assert.equal(result.answer, 'короткий ответ дешёвой модели')
  assert.equal(result.wroteBack, true)
  assert.deepEqual(calls, ['l2'], 'L3 не должен вызываться после ответа L2')
  assert.equal(seenPreset.model, 'cheap-model')
  assert.equal(seenPreset.contract.noAnswer, 'NO_ANSWER')

  const entry = store.getEntry(result.entryId)
  assert.equal(entry.kind, 'answer')
  assert.equal(entry.status, 'draft')
  assert.equal(entry.text, 'короткий ответ дешёвой модели')
  assert.equal(entry.source_ref, 'task/012')
  assert.equal(entry.author, 'cascade:L2')

  const [route] = store.listMetrics({ event: 'route' })
  assert.equal(route.payload.layer, 'L2')
  assert.equal(route.payload.tokens_saved_estimate, 500)
  assert.equal(memoryStats(store).tokens_saved_estimate, 500)
})

test('L2 NO_ANSWER: вызывается L3, ответ пишется draft с source по умолчанию', async (t) => {
  const store = tempStore(t)
  const calls = []
  const providers = {
    l2: () => {
      calls.push('l2')
      return { status: 'NO_ANSWER' }
    },
    l3: ({ escalatedFrom }) => {
      calls.push(`l3:${escalatedFrom}`)
      return { answer: 'ответ основной модели' }
    },
  }

  const result = await runCascade({
    store,
    query: 'сложный вопрос',
    providers,
    config: { cascade: { enabled: true } },
    now: () => NOW,
  })

  assert.equal(result.layer, 'L3')
  assert.deepEqual(calls, ['l2', 'l3:L2'])
  assert.equal(result.wroteBack, true)
  assert.equal(store.getEntry(result.entryId).source_ref, 'cascade:L3')
  assert.equal(store.getEntry(result.entryId).status, 'draft')

  const [route] = store.listMetrics({ event: 'route' })
  assert.equal(route.payload.layer, 'L3')
  assert.equal(route.payload.tokens_saved_estimate, 0)
})

test('ошибка L2 не ломает ход: эскалация на L3', async (t) => {
  const store = tempStore(t)
  const providers = {
    l2: () => { throw new Error('triage down') },
    l3: () => ({ answer: 'ответ после сбоя L2' }),
  }

  const result = await runCascade({ store, query: 'вопрос', providers, config: { cascade: { enabled: true } }, now: () => NOW })
  assert.equal(result.layer, 'L3')
  assert.equal(result.answer, 'ответ после сбоя L2')
  const [route] = store.listMetrics({ event: 'route' })
  assert.equal(route.payload.reason, 'triage error')
})

test('каскад выключен: L2 не вызывается, L3 отвечает и пишет draft', async (t) => {
  const store = tempStore(t)
  const calls = []
  const providers = {
    l2: () => { calls.push('l2'); return 'ответ L2' },
    l3: () => { calls.push('l3'); return 'ответ L3' },
  }

  const result = await runCascade({ store, query: 'вопрос', providers, config: { cascade: { enabled: false } }, now: () => NOW })
  assert.equal(result.layer, 'L3')
  assert.deepEqual(calls, ['l3'])
  assert.equal(result.wroteBack, true)
})

test('ошибка write-back не ломает ответ', async (t) => {
  const store = tempStore(t)
  const providers = {
    l2: () => ({ answer: 'ответ, который не удалось записать' }),
    l3: () => ({ answer: 'L3' }),
  }
  const write = () => { throw new Error('db down') }

  const result = await runCascade({
    store,
    query: 'вопрос',
    providers,
    config: { cascade: { enabled: true } },
    write,
    now: () => NOW,
  })

  assert.equal(result.layer, 'L2')
  assert.equal(result.answer, 'ответ, который не удалось записать')
  assert.equal(result.wroteBack, false)
  assert.match(result.error, /db down/)
})

test('контракт: пустой запрос и отсутствие L3-провайдера — ошибки', async (t) => {
  const store = tempStore(t)
  await assert.rejects(() => runCascade({ store, query: '   ', providers: { l3: () => 'x' } }), /непустой query/)
  await assert.rejects(
    () => runCascade({ store, query: 'вопрос', providers: {}, config: { cascade: { enabled: false } } }),
    /providers\.l3/,
  )
})

test('write_back: false отключает запись ответа в память', async (t) => {
  const store = tempStore(t)
  const providers = { l2: () => ({ answer: 'ответ без записи' }), l3: () => ({ answer: 'L3' }) }

  const result = await runCascade({
    store,
    query: 'вопрос',
    providers,
    config: { cascade: { enabled: true, write_back: false } },
    now: () => NOW,
  })

  assert.equal(result.layer, 'L2')
  assert.equal(result.wroteBack, false)
  assert.equal(result.entryId, null)
  assert.equal(store.countEntries(), 0)
})

test('строковый NO_ANSWER: эскалация на L3, в память пишется только ответ L3', async (t) => {
  const store = tempStore(t)
  const calls = []
  const providers = {
    l2: () => { calls.push('l2'); return 'NO_ANSWER' },
    l3: () => { calls.push('l3'); return 'ответ основной модели' },
  }

  const result = await runCascade({ store, query: 'вопрос', providers, config: { cascade: { enabled: true } }, now: () => NOW })
  assert.equal(result.layer, 'L3')
  assert.deepEqual(calls, ['l2', 'l3'])
  assert.equal(result.answer, 'ответ основной модели')
  assert.equal(store.countEntries(), 1)
  assert.equal(store.getEntry(result.entryId).text, 'ответ основной модели')
  assert.equal(store.getEntry(result.entryId).source_ref, 'cascade:L3')
  const [route] = store.listMetrics({ event: 'route' })
  assert.equal(route.payload.layer, 'L3')
})

test('контракт в строках: регистр, причина и префикс ANSWER', async (t) => {
  const store = tempStore(t)
  const cases = [
    { l2: ' no_answer ', layer: 'L3' },
    { l2: 'NO_ANSWER: не уверен', layer: 'L3' },
    { l2: 'no_answer — нет данных', layer: 'L3' },
    { l2: 'ANSWER', layer: 'L3' },
    { l2: 'NO_ANSWER.', layer: 'L3' },
    { l2: 'no_answer!', layer: 'L3' },
    { l2: 'NO_ANSWER,', layer: 'L3' },
    { l2: 'NO_ANSWER — причина.', layer: 'L3' },
    { l2: 'ANSWER.', layer: 'L3' },
    { l2: 'ANSWER!', layer: 'L3' },
    { l2: 'ANSWER: .', layer: 'L3' },
    { l2: 'ANSWER: короткий ответ', layer: 'L2', answer: 'короткий ответ' },
    { l2: 'answer — с дефисом', layer: 'L2', answer: 'с дефисом' },
    { l2: 'ANSWER: ответ с точкой.', layer: 'L2', answer: 'ответ с точкой.' },
    { l2: 'обычный текстовый ответ', layer: 'L2', answer: 'обычный текстовый ответ' },
  ]

  for (const item of cases) {
    const calls = []
    const providers = {
      l2: () => { calls.push('l2'); return item.l2 },
      l3: () => { calls.push('l3'); return 'ответ L3' },
    }
    const result = await runCascade({ store, query: `вопрос ${item.l2}`, providers, config: { cascade: { enabled: true } }, now: () => NOW })
    assert.equal(result.layer, item.layer, `для ${JSON.stringify(item.l2)}`)
    if (item.answer !== undefined) {
      assert.equal(result.answer, item.answer)
      assert.deepEqual(calls, ['l2'])
    } else {
      assert.deepEqual(calls, ['l2', 'l3'])
      assert.equal(store.getEntry(result.entryId).text, 'ответ L3')
    }
  }
})

test('объектный ответ со строкой NO_ANSWER/ANSWER-пунктуацией в answer — отказ', async (t) => {
  const store = tempStore(t)
  for (const reply of [
    { status: 'ANSWER', answer: 'NO_ANSWER' },
    { status: 'ANSWER', answer: 'NO_ANSWER.' },
    { answer: 'no_answer!' },
    { answer: 'ANSWER.' },
    { answer: ' ANSWER! ' },
  ]) {
    const calls = []
    const providers = {
      l2: () => reply,
      l3: () => { calls.push('l3'); return 'ответ L3' },
    }

    const result = await runCascade({ store, query: 'вопрос', providers, config: { cascade: { enabled: true } }, now: () => NOW })
    assert.equal(result.layer, 'L3', `для ${JSON.stringify(reply)}`)
    assert.deepEqual(calls, ['l3'])
    assert.equal(store.getEntry(result.entryId).text, 'ответ L3')
  }
})
