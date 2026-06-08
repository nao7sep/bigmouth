/**
 * Plain-text helpers for deriving short display labels from post bodies.
 */

/** Default length of a body-derived excerpt, in code points. */
export const EXCERPT_MAX_CHARS = 100;

function isAsciiWhitespace(ch: string): boolean {
  return (
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\r" ||
    ch === "\f" ||
    ch === "\v"
  );
}

/**
 * Flattens Markdown body text into a single-line excerpt: every run of
 * whitespace (including newlines) collapses to one ASCII space, leading and
 * trailing whitespace is dropped, and at most `maxChars` code points are kept.
 *
 * Implemented as a single forward scan that stops as soon as `maxChars` is
 * reached, so a long body costs O(maxChars), not O(body length): it never
 * splits the whole string into lines or rewrites the entire text. Iterating
 * with `for…of` walks code points, so a surrogate pair (e.g. an emoji) is never
 * cut in half. Markdown markers are not stripped — the goal is a faithful, cheap
 * preview, not rendered text.
 */
export function minifyExcerpt(body: string, maxChars: number = EXCERPT_MAX_CHARS): string {
  if (maxChars <= 0) return "";

  let out = "";
  let count = 0;
  let pendingSpace = false;

  for (const ch of body) {
    if (isAsciiWhitespace(ch)) {
      // Collapse the run; defer the separator so leading and trailing
      // whitespace never reaches the output.
      if (count > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      count += 1;
      pendingSpace = false;
      if (count >= maxChars) break;
    }
    out += ch;
    count += 1;
    if (count >= maxChars) break;
  }

  return out;
}
