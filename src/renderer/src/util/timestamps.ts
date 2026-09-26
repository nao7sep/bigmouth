import type { Translator } from "@shared/i18n/translate";

/**
 * Formats a UTC ISO timestamp for display in the given IANA time zone, with the
 * interface language's date and time format (the translator's dateTime).
 * Conversion to the workspace's zone happens here, at the display edge, so the
 * output never depends on anything but the zone passed. Returns "" for an
 * unparseable timestamp.
 */
export function formatLocalDateTime(iso: string, timeZone: string, dateTime: Translator["dateTime"]): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return dateTime(d, timeZone);
}
