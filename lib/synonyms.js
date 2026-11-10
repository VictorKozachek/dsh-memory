/**
 * Локальный словарь синонимов для расширения запроса (задача 020).
 *
 * Файл `data/synonyms.json` лежит в репозитории/пакете, сеть не используется.
 * Расширение включается конфигом `search.synonyms` (по умолчанию включено) и
 * выключается флагом `synonyms: false` в `memory.search`.
 *
 * @module dsh-memory/synonyms
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Путь к встроенному словарю. */
export const SYNONYMS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'synonyms.json')

/** @type {Map<string, readonly string[]> | null} */
let cache = null

/**
 * Прочитать словарь один раз и построить индекс по нижнему регистру.
 *
 * @param {string} [file] — путь к JSON (для тестов).
 * @returns {Map<string, readonly string[]>} слово → синонимы.
 */
export function loadSynonyms(file = SYNONYMS_FILE) {
  if (cache !== null && file === SYNONYMS_FILE) return cache
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const map = new Map()
  for (const [word, values] of Object.entries(parsed)) {
    const key = word.trim().toLowerCase()
    if (key === '' || !Array.isArray(values)) continue
    map.set(key, [...new Set(values
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value !== ''))])
  }
  if (file === SYNONYMS_FILE) cache = map
  return map
}

/**
 * Синонимы для одного токена (по точному нижнему регистру).
 *
 * @param {string} word — токен.
 * @param {Map<string, readonly string[]>} [dictionary] — словарь.
 * @returns {string[]} синонимы.
 */
export function synonymsFor(word, dictionary = loadSynonyms()) {
  return [...(dictionary.get(String(word ?? '').trim().toLowerCase()) ?? [])]
}
