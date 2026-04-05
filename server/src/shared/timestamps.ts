/**
 * Timestamp utility module.
 *
 * All internal timestamps are UTC. Conversion is always one-way:
 * UTC -> configured display timezone. The app never converts local time to UTC.
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
 * Formats a UTC Date for display in the configured timezone.
 *
 * Example: 2026-04-05T14:30:22Z in "Asia/Tokyo" -> "2026-04-05 23:30:22 GMT+9"
 */
export function formatForDisplay(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });

  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  const datePart = `${get("year")}-${get("month")}-${get("day")}`;
  const timePart = `${get("hour")}:${get("minute")}:${get("second")}`;
  const tz = get("timeZoneName");

  return `${datePart} ${timePart} ${tz}`;
}

/**
 * Formats a UTC Date for storage in front matter.
 * Output: ISO 8601 UTC string.
 *
 * Example: "2026-04-05T14:30:22Z"
 */
export function formatForFrontMatter(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
