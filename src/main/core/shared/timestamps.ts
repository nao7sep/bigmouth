/**
 * Timestamp utility module.
 *
 * All internal timestamps are UTC and serialized in the canonical ISO 8601 form
 * (exactly 3 fractional digits + Z). Conversion to local time happens only at
 * the client display edge; the server never converts local time to UTC.
 */

/**
 * Returns the current UTC time as a Date object.
 * Uses the OS clock (Date.now()), never an AI's internal clock.
 */
export function utcNow(): Date {
  return new Date();
}

/**
 * Formats a UTC Date for use in filenames.
 * Output: "yyyymmdd-hhmmss-utc" (per playbook convention).
 *
 * Example: 2026-04-05T14:30:22Z -> "20260405-143022-utc"
 */
export function formatForFilename(date: Date): string {
  const y = date.getUTCFullYear().toString();
  const mo = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  const h = pad2(date.getUTCHours());
  const mi = pad2(date.getUTCMinutes());
  const s = pad2(date.getUTCSeconds());
  return `${y}${mo}${d}-${h}${mi}${s}-utc`;
}

/**
 * Serializes a UTC Date to the canonical internal/stored form: ISO 8601
 * extended, always exactly 3 fractional digits and a Z suffix. Used for front
 * matter, asset metadata, and log lines. `toISOString()` emits exactly this.
 *
 * Example: "2026-04-05T14:30:22.123Z"
 */
export function formatUtcIso(date: Date): string {
  return date.toISOString();
}

/**
 * Compares two UTC ISO timestamp strings by the instant they denote, ascending
 * (earliest first). Parses rather than comparing code units, so it orders any
 * valid form correctly regardless of fractional-digit count or `Z`/`+00:00`,
 * and an absent/unparseable value sorts earliest. Use swapped args for
 * descending (newest first).
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

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
