/**
 * The value rules for workspace settings, in one place. The Settings modal's
 * Save gate, its field messages and the IPC persistence gate all read them, so
 * the screen and the boundary accept exactly the same values.
 *
 * Type narrowing stays in the main process, where the payload arrives as
 * `unknown`. This module is about values a person can get wrong, so it takes an
 * already-typed `Settings` and answers per field — which is what lets the modal
 * render a message beside the offending input and the boundary throw on the
 * first one, from the same source.
 */

import type { Settings } from "./types.js";
import { SYSTEM_TIME_ZONE, isValidTimeZone } from "./timeZone.js";
import { message, type Message } from "./i18n/translate.js";
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
  | "postsPerLoad"
  | "contentFont.size"
  | "contentFont.lineHeight"
  | "contentFont.padding";

/**
 * A message per field that is wrong; a field that is fine is simply absent.
 * The modal shows it in the interface language; the boundary names its key.
 */
export type SettingsFieldErrors = Partial<Record<SettingsField, Message>>;

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

function withinBounds(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

/**
 * A number field's text as the value it means: NaN for an empty field or one
 * that is not a number as a whole, so the field's message, not a guess such as
 * `parseInt`'s leading digits, decides what happens to it.
 */
export function numberFieldValue(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text);
}

// The list offers only System and zones the runtime resolves, so this guards
// the IPC boundary against anything else.
function timezoneError(timezone: string): Message | null {
  return timezone === SYSTEM_TIME_ZONE || isValidTimeZone(timezone) ? null : message("settings.timezoneInvalid");
}

/**
 * Duplicates are deliberately NOT an error: the store de-duplicates and sorts
 * the list on save, which is commit-time cleanup rather than a mistake to
 * refuse.
 */
function languagesError(languages: readonly string[]): Message | null {
  if (languages.length === 0) return message("settings.languagesRequired");
  const failing = languages.find((l) => !/^[a-z]{2}$/.test(l));
  return failing === undefined ? null : message("settings.languageCodeInvalid", { code: failing });
}

/** The value rules for one set; the sets without rules have no messages. */
export function settingsSetErrors<K extends keyof Settings>(key: K, value: Settings[K]): SettingsFieldErrors {
  const errors: SettingsFieldErrors = {};
  const set = (field: SettingsField, error: Message | null): void => {
    if (error !== null) errors[field] = error;
  };
  const positiveInteger = message("settings.positiveInteger");
  const between = (min: number, max: number) => message("settings.between", { min, max });
  const bounded = (field: SettingsField, v: number, min: number, max: number) =>
    set(field, withinBounds(v, min, max) ? null : between(min, max));
  const wholeBounded = (field: SettingsField, v: number, min: number, max: number) =>
    set(field, Number.isInteger(v) && withinBounds(v, min, max) ? null : message("settings.wholeBetween", { min, max }));

  switch (key) {
    case "timezone":
      set("timezone", timezoneError(value as Settings["timezone"]));
      break;
    case "supportedLanguages":
      set("supportedLanguages", languagesError(value as Settings["supportedLanguages"]));
      break;
    case "postsPerLoad":
      set(key, isPositiveInteger(value as number) ? null : positiveInteger);
      break;
    case "contentFont": {
      const font = value as Settings["contentFont"];
      wholeBounded("contentFont.size", font.size, CONTENT_FONT_SIZE_MIN, CONTENT_FONT_SIZE_MAX);
      bounded("contentFont.lineHeight", font.lineHeight, CONTENT_LINE_HEIGHT_MIN, CONTENT_LINE_HEIGHT_MAX);
      wholeBounded("contentFont.padding", font.padding, CONTENT_PADDING_MIN, CONTENT_PADDING_MAX);
      break;
    }
  }
  return errors;
}

const RULED_SETS = ["timezone", "supportedLanguages", "postsPerLoad", "contentFont"] as const;

export function settingsFieldErrors(settings: Settings): SettingsFieldErrors {
  return Object.assign({}, ...RULED_SETS.map((key) => settingsSetErrors(key, settings[key])));
}

/** The first offending field and its message, or null when every field is valid. */
export function firstSettingsError(settings: Settings): { field: SettingsField; message: Message } | null {
  const errors = settingsFieldErrors(settings);
  for (const [field, error] of Object.entries(errors)) {
    return { field: field as SettingsField, message: error };
  }
  return null;
}
