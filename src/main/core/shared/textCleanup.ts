/**
 * Whitespace-cleanup and truncation helpers, per the fleet text-cleanup
 * conventions. These realize the canonical behavior contract locally — there is
 * no cross-app shared package — and are copied verbatim from the convention's
 * reference implementation.
 *
 * The main process uses two of the three patterns:
 *
 * - `multiline` normalizes post bodies on read and write. Post bodies are
 *   Markdown, so callers keep trailing whitespace (two trailing spaces are a
 *   Markdown hard line break) by passing `trimLineEnds: false`.
 * - `truncate` derives a single-line, grapheme-safe preview label from an
 *   untitled post's body for the index.
 *
 * Cleanup is a commit/display-time operation, never mid-edit (see the
 * text-input-ime conventions).
 */

/**
 * Normalizes a multiline body. Splits on `\r\n | \r | \n` and rejoins with
 * `\n`, so newlines are normalized as a side effect.
 *
 * - `trimLineEnds` (default true): drop each line's trailing whitespace. Off for
 *   Markdown bodies that rely on two trailing spaces as a hard line break.
 * - `dropEdgeBlankLines` (default true): drop blank lines before the first and
 *   after the last visible line. A line is blank when its trimmed form is empty.
 * - `collapseBlankLines` (default false): reduce interior runs of blank lines to
 *   one. Off by default because an interior blank run is often a deliberate
 *   section break.
 */
export function multiline(
  text: string,
  opts: { trimLineEnds?: boolean; dropEdgeBlankLines?: boolean; collapseBlankLines?: boolean } = {},
): string {
  const { trimLineEnds = true, dropEdgeBlankLines = true, collapseBlankLines = false } = opts;
  const isBlank = (l: string) => l.trim() === "";
  let lines = text.split(/\r\n|\r|\n/);
  if (trimLineEnds) lines = lines.map((l) => l.replace(/\s+$/, ""));

  let start = 0;
  let end = lines.length;
  if (dropEdgeBlankLines) {
    while (start < end && isBlank(lines[start])) start++;
    while (end > start && isBlank(lines[end - 1])) end--;
  }

  const out: string[] = [];
  let prevBlank = false;
  for (const line of lines.slice(start, end)) {
    const blank = isBlank(line);
    if (collapseBlankLines && blank && prevBlank) continue;
    out.push(line);
    prevBlank = blank;
  }
  return out.join("\n");
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
}

/**
 * Produces the first part of a possibly-multiline body as a single line, for a
 * preview label.
 *
 * - Whitespace runs (including newlines) collapse to one ASCII space.
 * - Stops once the buffer reaches `n` graphemes — a minimum length, not exact; a
 *   few over is fine. Reading is by grapheme, so emoji and combining sequences
 *   never split.
 * - Leading and trailing whitespace are dropped (a pending space is flushed only
 *   before a visible grapheme).
 * - `truncated` is true only when a visible grapheme exists past the cut point,
 *   so an all-whitespace tail never reports a cut. `n <= 0` yields an empty,
 *   not-truncated result.
 */
export function truncate(text: string, n: number): TruncateResult {
  if (n <= 0) return { text: "", truncated: false };
  const out: string[] = [];
  let pendingSpace = false;
  let budgetMet = false;
  let truncated = false;

  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    const isWhitespace = segment.trim() === "";
    if (!budgetMet) {
      if (isWhitespace) {
        if (out.length > 0) pendingSpace = true; // skip leading, hold trailing
        continue;
      }
      if (pendingSpace) {
        out.push(" ");
        pendingSpace = false;
      }
      out.push(segment);
      if (out.length >= n) budgetMet = true;
    } else if (!isWhitespace) {
      truncated = true; // a visible grapheme exists past the cut point
      break;
    }
  }
  return { text: out.join(""), truncated };
}
