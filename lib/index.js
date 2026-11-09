/**
 * Host-половина плагина `dsh-memory` — каркас (задача 001).
 *
 * Пакет ставится в профиль как обычный bundle: `package.json` объявляет
 * `dsh.bundle.patch`, а `cordis.patch.yml` вставляет Loader-ряд с именем
 * пакета. Cordis импортирует ESM-точку входа и вызывает `apply(ctx, config)` —
 * это единственный контракт, который скелет обязан держать.
 *
 * Скелет намеренно ничего не требует от профиля: `inject` не объявлен, сервисы
 * (`ctx.tools`, `ctx.agents`, `ctx.tokenMeter`) ещё не нужны, поэтому плагин
 * грузится и в пустом профиле. Хранилище, инструменты `memory.*`, инъекция
 * top-k и конфиг придут в задачах 002–014; единственная оставленная здесь
 * точка входа для них — сервис `ctx.memory`, который регистрируется ниже.
 *
 * Ошибка скелета не должна ломать загрузку профиля (риск из PLAN.md: «плагин
 * ломает ход при ошибке»): регистрация обёрнута в try/catch и только пишет
 * предупреждение в лог, если сервис занять не удалось.
 *
 * @module dsh-memory
 */

/** Имя плагина: cordis использует его в диагностике, оно же видно в логе. */
export const name = 'dsh-memory'

/** Имя сервиса в контексте cordis, через который части плагина видят состояние. */
export const serviceName = 'memory'

/**
 * Параметры плагина.
 *
 * Пока это свободный объект: схему конфига с дефолтами и `DSH_MEMORY_*`
 * вводит задача 008, до тех пор скелет принимает всё, что положил ряд, и
 * хранит копию.
 *
 * @typedef {{ namespace?: string }} Config
 */

/**
 * Зарегистрировать плагин в контексте cordis.
 *
 * Сервис `memory` — точка, за которую дальше цепляются инструменты
 * `memory.*` (задачи 004–007), инъекция top-k (010) и метрики (011). До них
 * сервис хранит только имя и конфиг.
 *
 * @param {object | undefined} ctx — контекст cordis; мок без сервисов тоже допустим.
 * @param {Config | null | undefined} [config] — конфиг ряда, невалидный заменяется на `{}`.
 */
export function apply(ctx, config = {}) {
  const options = freezeConfig(config)
  const memory = Object.freeze({ name, config: options })
  try {
    ctx?.provide?.(serviceName, memory)
    log(ctx, 'debug', `плагин загружен (namespace: ${options.namespace ?? 'auto'})`)
  } catch (error) {
    log(ctx, 'warn', `не удалось зарегистрировать сервис "${serviceName}": ${error?.message ?? error}`)
  }
}

/**
 * Снять с конфига изменяемость и отбросить мусор: плагин не должен падать из-за
 * того, что ряд передал `null`, массив или скаляр.
 *
 * @param {unknown} config — значение `config` из Loader-ряда.
 * @returns {Readonly<Config>} замороженная копия или пустой объект.
 */
function freezeConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return Object.freeze({})
  }
  return Object.freeze({ ...config })
}

/**
 * Записать сообщение в лог cordis, если он есть. Лог — не причина падать:
 * при любой ошибке плагин молчит.
 *
 * @param {object | undefined} ctx — контекст cordis (у мок-контекста логера может не быть).
 * @param {'debug' | 'info' | 'warn'} level — уровень сообщения.
 * @param {string} message — текст без префикса.
 */
function log(ctx, level, message) {
  try {
    const logger = ctx?.logger
    const write = logger?.[level] ?? logger?.info
    if (typeof write === 'function') write.call(logger, `[${name}] ${message}`)
  } catch {
    // Диагностика не может уронить загрузку профиля.
  }
}
