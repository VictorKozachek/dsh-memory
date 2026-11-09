/**
 * Тесты каркаса плагина: загрузка модуля, регистрация на мок-`ctx` без сервисов
 * и упаковка bundle-пакета.
 *
 * Запуск: `npm test` (это `node --test`).
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as plugin from '../lib/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'lib/index.js')
const patchFile = join(root, 'cordis.patch.yml')

/** Мок cordis-контекста: только те методы, которые трогает скелет. */
function mockContext() {
  const services = new Map()
  const logged = []
  return {
    services,
    logged,
    provide(service, value) {
      services.set(service, value)
      return () => services.delete(service)
    },
    logger: {
      debug: (message) => logged.push(message),
      info: (message) => logged.push(message),
      warn: (message) => logged.push(message),
    },
  }
}

test('модуль экспортирует имя плагина и apply', () => {
  assert.equal(plugin.name, 'dsh-memory')
  assert.equal(plugin.serviceName, 'memory')
  assert.equal(typeof plugin.apply, 'function')
  // Обязателен только ctx; config — необязательный второй аргумент Loader-ряда.
  assert.equal(plugin.apply.length, 1)
})

test('модуль загружается штатным для ESM способом без ошибок', () => {
  // Критерий карточки: `node --input-type=module` грузит точку входа и видит apply.
  const script = [
    `const mod = await import(${JSON.stringify(pathToFileURL(entry).href)})`,
    `if (typeof mod.apply !== 'function') throw new Error('apply не экспортирован')`,
    `if (mod.name !== 'dsh-memory') throw new Error('имя плагина не dsh-memory')`,
  ].join('\n')
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root })
})

test('apply регистрирует сервис memory на мок-контексте', () => {
  const ctx = mockContext()
  assert.doesNotThrow(() => plugin.apply(ctx, { namespace: 'demo' }))

  const memory = ctx.services.get('memory')
  assert.ok(memory, 'сервис memory не зарегистрирован')
  assert.equal(memory.name, 'dsh-memory')
  assert.equal(memory.config.namespace, 'demo')
})

test('apply не падает без сервисов и без конфига', () => {
  // Пустой контекст: cordis-профиль без tools/agents/tokenMeter.
  assert.doesNotThrow(() => plugin.apply({}))
  assert.doesNotThrow(() => plugin.apply(undefined, undefined))
  assert.doesNotThrow(() => plugin.apply({}, null))
  assert.doesNotThrow(() => plugin.apply({}, ['namespace']))
  assert.doesNotThrow(() => plugin.apply({}, 'demo'))
})

test('занятый сервис не роняет загрузку плагина', () => {
  const ctx = {
    provide() {
      throw new Error('service "memory" has been registered')
    },
    logger: { warn() {} },
  }
  assert.doesNotThrow(() => plugin.apply(ctx))
})

test('конфиг копируется и замораживается', () => {
  const config = { namespace: 'demo' }
  const ctx = mockContext()
  plugin.apply(ctx, config)

  const memory = ctx.services.get('memory')
  assert.notEqual(memory.config, config, 'конфиг должен быть копией, а не ссылкой')
  assert.ok(Object.isFrozen(memory.config))
  assert.ok(Object.isFrozen(memory))
})

test('package.json описывает bundle-пакет с ESM-точкой входа', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-memory')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')

  // `npm pack` берёт только эти пути; package.json npm добавляет сам.
  assert.ok(pkg.files.includes('lib'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  assert.ok(existsSync(entry), 'нет lib/index.js')
  assert.ok(existsSync(patchFile), 'нет cordis.patch.yml')
})

test('cordis.patch.yml вставляет ряд, монтирующий пакет', () => {
  const patch = readFileSync(patchFile, 'utf8')
  assert.match(patch, /^- insert:/m)
  assert.match(patch, /^\s+- id: dsh-memory$/m)
  assert.match(patch, /^\s+name: dsh-memory$/m)
})
