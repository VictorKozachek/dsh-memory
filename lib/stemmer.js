/**
 * Русский стеммер Snowball (задача 020): чистый JS, без зависимостей.
 *
 * Применяется к словам при индексации (в `title_lex`/`text_lex`) и к токенам
 * запроса, поэтому словоформы («индексатор», «индексатора», «индексация»)
 * сводятся к общей основе. Латиница и цифры не стеммируются.
 *
 * Реализация повторяет шаги Snowball Russian: области RV/R1/R2, удаление
 * окончаний (деепричастие, прилагательное/причастие, возвратное, глагол,
 * существительное), удаление «и», словообразовательное «ость/ост» в R2 и
 * финальные правила (нн → н, превосходная степень, ь, е).
 *
 * @module dsh-memory/stemmer
 */

const VOWELS = new Set('аеиоуыэюя')

/** Окончания для шага 1 (внутри группы — от длинных к коротким). */
const PERFECTIVE_GERUND_1 = ['вшись', 'вши', 'в']
const PERFECTIVE_GERUND_2 = ['ившись', 'ывшись', 'ивши', 'ывши', 'ив', 'ыв']
const ADJECTIVAL = [
  'ими', 'ыми', 'его', 'ого', 'ему', 'ому', 'ее', 'ие', 'ые', 'ое', 'ей', 'ий',
  'ый', 'ой', 'ем', 'им', 'ым', 'ом', 'их', 'ых', 'ую', 'юю', 'ая', 'яя', 'ою', 'ею',
]
const PARTICIPLE = ['ющ', 'ем', 'нн', 'вш', 'щ']
const REFLEXIVE = ['ся', 'сь']
const VERB = [
  'ешь', 'нно', 'ете', 'ейте', 'уйте', 'ите', 'ила', 'ыла', 'ена', 'или', 'ыли',
  'ей', 'уй', 'ил', 'ыл', 'им', 'ым', 'ен', 'ено', 'ило', 'ыло', 'ят', 'ует', 'уют',
  'ены', 'ить', 'ыть', 'ишь', 'ую', 'ла', 'на', 'ли', 'й', 'л', 'ем', 'н', 'ло',
  'но', 'ет', 'ют', 'ны', 'ть', 'ю',
]
const NOUN = [
  'иями', 'ями', 'ами', 'ией', 'иям', 'ием', 'иях', 'ев', 'ов', 'ие', 'ье', 'еи',
  'ии', 'ей', 'ой', 'ий', 'ям', 'ем', 'ам', 'ом', 'ах', 'ях', 'ию', 'ью', 'ия', 'ья',
  'а', 'е', 'и', 'й', 'о', 'у', 'ы', 'ь', 'ю', 'я',
]
const DERIVATIONAL = ['ость', 'ост']
const SUPERLATIVE = ['ейше', 'ейш']

/**
 * Стемминг одного слова.
 *
 * @param {string} word — слово (кириллица/латиница).
 * @returns {string} основа; латиница/цифры возвращаются в нижнем регистре.
 */
export function stemWord(word) {
  const value = String(word ?? '').toLowerCase()
  if (value === '' || !/\p{Script=Cyrillic}/u.test(value)) return value

  const rv = regionAfterFirstVowel(value)
  const r2 = regionR2(value)
  let w = value

  // Шаг 1: одна группа окончаний, первая найденная.
  const gerund2 = removeEnding(w, PERFECTIVE_GERUND_2, rv)
  const gerund1 = gerund2 === null ? removeEnding(w, PERFECTIVE_GERUND_1, rv) : null
  if (gerund2 !== null) {
    w = gerund2
  } else if (gerund1 !== null) {
    w = gerund1
  } else {
    const adjectival = removeEnding(w, ADJECTIVAL, rv)
    if (adjectival !== null) {
      const withoutParticiple = removeEnding(adjectival, PARTICIPLE, rv)
      w = withoutParticiple ?? adjectival
    } else {
      const reflexive = removeEnding(w, REFLEXIVE, rv)
      const verb = reflexive === null ? removeEnding(w, VERB, rv) : null
      const noun = reflexive === null && verb === null ? removeEnding(w, NOUN, rv) : null
      if (reflexive !== null) w = reflexive
      else if (verb !== null) w = verb
      else if (noun !== null) w = noun
    }
  }

  // Шаг 2: удалить «и».
  w = removeEnding(w, ['и'], rv) ?? w
  // Шаг 3: словообразовательное «ость/ост» — только в R2.
  w = removeEnding(w, DERIVATIONAL, r2) ?? w
  // Шаг 4: нн → н, превосходная степень, ь, е.
  if (w.endsWith('нн') && w.length - 2 >= rv) w = w.slice(0, -1)
  const superlative = removeEnding(w, SUPERLATIVE, rv)
  if (superlative !== null) {
    w = superlative
    if (w.endsWith('нн') && w.length - 2 >= rv) w = w.slice(0, -1)
  }
  w = removeEnding(w, ['ь'], rv) ?? w
  w = removeEnding(w, ['е'], rv) ?? w
  return w
}

/**
 * Разбить текст на слова для лексического индекса.
 *
 * @param {string} text — текст.
 * @returns {string[]} токены в нижнем регистре.
 */
export function tokenize(text) {
  return (String(text ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
}

/**
 * Стеммированный текст для FTS5-колонок `title_lex`/`text_lex`.
 *
 * @param {string} text — исходный текст.
 * @returns {string} пробел-разделённые основы.
 */
export function stemText(text) {
  return tokenize(text).flatMap(stemVariants).join(' ')
}

/**
 * «Мягкая» основа: срезаются только падежные окончания существительных, без
 * глагольных групп Snowball. Нужна как второй вариант для запросов/индекса:
 * Snowball разводит «память» (глагольное «ть») и «памяти» (существительное), а
 * мягкая основа сводит обе формы к «памят».
 *
 * @param {string} word — слово.
 * @returns {string} мягкая основа.
 */
export function stemWordLoose(word) {
  const value = String(word ?? '').toLowerCase()
  if (value === '' || !/\p{Script=Cyrillic}/u.test(value)) return value
  let w = value
  w = removeEnding(w, NOUN, 0) ?? w
  w = removeEnding(w, ['ь'], 0) ?? w
  return w
}

/**
 * Варианты основы слова: Snowball и мягкая, без дублей.
 *
 * @param {string} word — слово.
 * @returns {string[]} одна или две основы.
 */
export function stemVariants(word) {
  return [...new Set([stemWord(word), stemWordLoose(word)])]
}

/**
 * Стеммированные токены запроса: для каждого слова — строгая Snowball-основа и
 * мягкая основа, чтобы находить словоформы, которые Snowball разводит.
 *
 * @param {string} text — запрос.
 * @returns {string[]} основы.
 */
export function stemTokens(text) {
  return tokenize(text).flatMap(stemVariants)
}

/**
 * Область после первой гласной (RV Snowball).
 *
 * @param {string} word — слово.
 * @returns {number} индекс начала области.
 */
function regionAfterFirstVowel(word) {
  for (let index = 0; index < word.length; index += 1) {
    if (VOWELS.has(word[index])) return index + 1
  }
  return word.length
}

/**
 * Область R1: после первой пары «гласная + согласная».
 *
 * @param {string} word — слово.
 * @returns {number} индекс начала области.
 */
function regionR1(word) {
  for (let index = 1; index < word.length; index += 1) {
    if (VOWELS.has(word[index - 1]) && !VOWELS.has(word[index])) return index + 1
  }
  return word.length
}

/**
 * Область R2: R1-правило, применённое внутри R1.
 *
 * @param {string} word — слово.
 * @returns {number} индекс начала области.
 */
function regionR2(word) {
  const start = regionR1(word)
  for (let index = start + 1; index < word.length; index += 1) {
    if (VOWELS.has(word[index - 1]) && !VOWELS.has(word[index])) return index + 1
  }
  return word.length
}

/**
 * Удалить самое длинное подходящее окончание, не заходя левее области.
 *
 * @param {string} word — слово.
 * @param {readonly string[]} endings — окончания (длинные первыми).
 * @param {number} minStart — минимальный индекс начала области (RV/R1/R2).
 * @returns {string | null} слово без окончания или `null`.
 */
function removeEnding(word, endings, minStart) {
  for (const ending of endings) {
    if (word.endsWith(ending) && word.length - ending.length >= minStart) {
      return word.slice(0, -ending.length)
    }
  }
  return null
}
