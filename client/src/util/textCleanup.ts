/**
 * Whitespace-cleanup helpers, per the fleet text-cleanup conventions. These
 * realize the canonical behavior contract locally — there is no cross-app shared
 * package — and are copied verbatim from the convention's reference
 * implementation.
 *
 * The client uses one of the three patterns: `singleLine`, applied at commit
 * time to scalar metadata fields edited in `<textarea>`s, which (unlike an
 * `<input>`) do not sanitize pasted newlines out. Cleanup runs on save, never on
 * a keystroke (see the text-input-ime conventions).
 */

/**
 * Tidies a scalar value for single-line storage and display. Always trims the
 * ends.
 *
 * - `flattenLineBreaks` (default true): every whitespace run that contains a
 *   line break collapses to one ASCII space, so a value pasted across lines
 *   becomes one line; pure horizontal spacing typed within a line is preserved.
 * - `minify` (default false): every run of one or more whitespace characters
 *   (including a lone full-width U+3000) collapses to one ASCII space. Because it
 *   collapses horizontal whitespace too, `minify` dominates `flattenLineBreaks`.
 *
 * This normalizes; it does not validate. Identity/strict-format fields (a slug,
 * a key) must be validated instead — not silently normalized.
 */
export function singleLine(
  text: string,
  opts: { flattenLineBreaks?: boolean; minify?: boolean } = {},
): string {
  const { flattenLineBreaks = true, minify = false } = opts;
  if (minify) return text.replace(/\s+/g, " ").trim();
  if (flattenLineBreaks) return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return text.trim();
}
