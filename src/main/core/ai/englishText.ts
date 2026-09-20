/**
 * The check that an English-only field actually came back in English.
 *
 * Several generated values are English whatever language the draft is written
 * in — the `*En` metadata fields, and every image prompt — and nothing used to
 * hold them to it. Only `slug` was checked, by its URL-safe pattern, so a
 * `titleEn` returned in Japanese passed every guard and was written into the
 * post's front matter, and a Japanese image prompt was handed to the author to
 * paste into an image model. The author was the only detector, and had to be
 * looking.
 *
 * Shared rather than duplicated because the two generators reach the same
 * conclusion from the same evidence; a second copy would be a second threshold
 * to keep in step.
 */

const ANY_LETTER = /\p{L}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;

/**
 * How much of a value may be written in another script before it is treated as
 * being in another language.
 *
 * A minority passes, because English prose legitimately carries a name in its
 * own script — a title naming 鬼滅の刃 or Пушкин is still an English title. A
 * majority means the value itself is in the other language, which is the
 * failure this exists to catch.
 */
const MAX_NON_LATIN_LETTER_SHARE = 0.5;

/**
 * Whether `value` reads as English text rather than text in another script.
 *
 * Letters decide it and nothing else does: digits, punctuation, spaces, symbols
 * and emoji belong to no script, and counting them would only move the ratio
 * toward whichever side had more of them. A value with no letters at all — a
 * bare number, say — has nothing to judge and passes.
 */
export function isEnglishScript(value: string): boolean {
  const letters = [...value].filter((character) => ANY_LETTER.test(character));
  if (letters.length === 0) return true;

  const nonLatin = letters.filter((character) => !LATIN_LETTER.test(character)).length;
  return nonLatin / letters.length <= MAX_NON_LATIN_LETTER_SHARE;
}
