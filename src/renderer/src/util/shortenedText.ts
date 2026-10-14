// Pure helpers for identifying text that is shortened (interface-styling
// conventions, Labels): a path keeps its final segment and loses its middle,
// and a message about several items names a few and counts the rest.

// Either separator, so a Windows path shortens like a POSIX one wherever the
// renderer meets it.
const SEPARATOR = /[\\/]/;

/**
 * A path split for middle shortening: `head` is everything up to and including
 * the separator before the final segment, `tail` is that segment with any
 * trailing separators it carries. A root, a bare name or a path made only of
 * separators has no head, so nothing of it is ever the part that shrinks first.
 */
export function splitPath(path: string): { head: string; tail: string } {
  let end = path.length;
  while (end > 0 && SEPARATOR.test(path.charAt(end - 1))) end--;
  let start = end;
  while (start > 0 && !SEPARATOR.test(path.charAt(start - 1))) start--;
  if (start === 0) return { head: "", tail: path };
  return { head: path.slice(0, start), tail: path.slice(start) };
}

/** The final segment a message names a path by, without trailing separators. */
export function finalSegment(path: string): string {
  const { tail } = splitPath(path);
  let end = tail.length;
  while (end > 0 && SEPARATOR.test(tail.charAt(end - 1))) end--;
  return end > 0 ? tail.slice(0, end) : tail;
}

/** How many items a several-item message names before it counts the rest. */
export const NAMED_LIMIT = 3;

/**
 * The names a message shows and how many it only counts. A name repeated (one
 * file with two problems, say) is named once and counted once.
 */
export function nameFew(names: readonly string[], limit = NAMED_LIMIT): { named: string[]; more: number } {
  const unique = [...new Set(names)];
  return { named: unique.slice(0, limit), more: Math.max(0, unique.length - limit) };
}
