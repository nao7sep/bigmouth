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
 * Formats a UTC ISO timestamp for display: local time, ISO-ish, 24-hour, no
 * localization — e.g. "2026-04-05 14:30". Conversion to local happens here, at
 * the display edge.
 */
export function formatLocalDateTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
