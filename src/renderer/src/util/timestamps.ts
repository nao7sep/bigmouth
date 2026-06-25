/**
 * Compares two UTC ISO timestamp strings by the instant they denote, ascending
 * (earliest first). Parses rather than comparing code units, so any valid form
 * orders correctly regardless of fractional-digit count or `Z`/`+00:00`, and an
 * absent/unparseable value sorts earliest. Use swapped args for descending.
 */
export function compareInstants(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
  if (Number.isNaN(ta)) return -1;
  if (Number.isNaN(tb)) return 1;
  if (ta < tb) return -1;
  if (ta > tb) return 1;
  return 0;
}

/**
 * Whether a string is an IANA time zone the runtime accepts. Used to clamp a
 * stored timezone to the default before it reaches the formatter, so a corrupt
 * or hand-edited setting degrades gracefully instead of throwing per row.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Formats a UTC ISO timestamp for display in the given IANA time zone, as
 * "yyyy-mm-dd HH:mm" (24-hour, no localization) — e.g. "2026-04-05 14:30".
 * Conversion to the user's configured zone happens here, at the display edge,
 * so the output never depends on the host machine's local zone. Returns "" for
 * an unparseable timestamp.
 */
export function formatLocalDateTime(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}
