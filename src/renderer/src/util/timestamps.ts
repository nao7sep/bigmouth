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
