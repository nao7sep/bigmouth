/**
 * The value rules for workspace settings, in one place.
 *
 * They were written three times — the Settings modal's Save gate, the modal's
 * message producer, and the IPC persistence gate — and the three had already
 * drifted: `maxUploadMb` was "integer ≥ 1" in the UI and `> 0` at the boundary,
 * so `0.5` was rejected on screen and accepted on the wire; `supportedLanguages`
 * was "non-empty, two-letter, unique" in the UI and "any array of strings" at
 * the boundary; `timezone` was Intl-resolvable in the UI and "non-empty string"
 * at the boundary. The content-font bounds are the counter-example that shows
 * the fix works: both sides import the same constants and cannot drift.
 *
 * Type narrowing stays in the main process, where the payload arrives as
 * `unknown`. This module is about values a person can get wrong, so it takes an
 * already-typed `Settings` and answers per field — which is what lets the modal
 * render a message beside the offending input and the boundary throw on the
 * first one, from the same source.
 */

import type { Settings } from "./types.js";
import {
  CONTENT_FONT_SIZE_MAX,
  CONTENT_FONT_SIZE_MIN,
  CONTENT_LINE_HEIGHT_MAX,
  CONTENT_LINE_HEIGHT_MIN,
  CONTENT_PADDING_MAX,
  CONTENT_PADDING_MIN,
} from "./types.js";

/**
 * The fields a person can get wrong, named by their path in the payload so the
 * IPC boundary can say which one it rejected while the modal shows the same
 * human sentence beside the input.
 */
export type SettingsField =
  | "timezone"
  | "supportedLanguages"
  | "publishedPostsPerLoad"
  | "maxUploadMb"
  | "contentFont.size"
  | "contentFont.lineHeight"
  | "contentFont.padding";

/** A message per field that is wrong; a field that is fine is simply absent. */
export type SettingsFieldErrors = Partial<Record<SettingsField, string>>;

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

function withinBounds(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

function timezoneError(timezone: string): string | null {
  if (!timezone.trim()) return "Timezone is required.";
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return null;
  } catch {
    return `"${timezone}" is not a valid IANA timezone.`;
  }
}

/**
 * Duplicates are deliberately NOT an error: the store de-duplicates and sorts
 * the list on save, which is commit-time cleanup rather than a mistake to
 * refuse. The modal used to call them invalid and block Save on them, while the
 * boundary accepted them and the store quietly fixed them — one of the three
 * disagreements this module exists to end.
 */
function languagesError(languages: readonly string[]): string | null {
  if (languages.length === 0) return "At least one language is required.";
  if (languages.some((l) => !/^[a-z]{2}$/.test(l))) {
    return "Each language must be a 2-letter lowercase code (e.g. en, ja).";
  }
  return null;
}

export function settingsFieldErrors(settings: Settings): SettingsFieldErrors {
  const errors: SettingsFieldErrors = {};
  const set = (field: SettingsField, message: string | null): void => {
    if (message !== null) errors[field] = message;
  };

  const font = settings.contentFont;
  set("timezone", timezoneError(settings.timezone));
  set("supportedLanguages", languagesError(settings.supportedLanguages));
  set(
    "publishedPostsPerLoad",
    isPositiveInteger(settings.publishedPostsPerLoad) ? null : "Must be a positive integer.",
  );
  set("maxUploadMb", isPositiveInteger(settings.maxUploadMb) ? null : "Must be a positive integer.");
  set(
    "contentFont.size",
    withinBounds(font.size, CONTENT_FONT_SIZE_MIN, CONTENT_FONT_SIZE_MAX)
      ? null
      : `Must be between ${CONTENT_FONT_SIZE_MIN} and ${CONTENT_FONT_SIZE_MAX}.`,
  );
  set(
    "contentFont.lineHeight",
    withinBounds(font.lineHeight, CONTENT_LINE_HEIGHT_MIN, CONTENT_LINE_HEIGHT_MAX)
      ? null
      : `Must be between ${CONTENT_LINE_HEIGHT_MIN} and ${CONTENT_LINE_HEIGHT_MAX}.`,
  );
  set(
    "contentFont.padding",
    withinBounds(font.padding, CONTENT_PADDING_MIN, CONTENT_PADDING_MAX)
      ? null
      : `Must be between ${CONTENT_PADDING_MIN} and ${CONTENT_PADDING_MAX}.`,
  );

  return errors;
}

/** The first offending field and its message, or null when every field is valid. */
export function firstSettingsError(settings: Settings): { field: SettingsField; message: string } | null {
  const errors = settingsFieldErrors(settings);
  for (const [field, message] of Object.entries(errors)) {
    return { field: field as SettingsField, message };
  }
  return null;
}
