// Pure rules for the app-wide settings in the storage root's config.json,
// shared by the main-process store and the renderer's Settings form.

import type { AppSettings, ThemePreference } from "./types.js";
import type { MessageKey } from "./i18n/catalogues.js";
import { normalizeLanguagePreference } from "./i18n/languages.js";

export const THEME_PREFERENCES: ReadonlyArray<{ value: ThemePreference; label: MessageKey }> = [
  { value: "system", label: "settings.themeSystem" },
  { value: "light", label: "settings.themeLight" },
  { value: "dark", label: "settings.themeDark" },
];

export function defaultAppSettings(): AppSettings {
  return { theme: "system", language: "system" };
}

/** A missing or unrecognized theme follows the OS. */
export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/**
 * Why a parsed config.json cannot be used as-is, or null when it can. A
 * non-object or a wrong-typed present field is corruption: coercing it and then
 * saving would silently destroy what the user wrote (storage-path conventions).
 * An absent field takes its default, and an unrecognized theme or language name
 * follows the OS, like any other value-level normalization.
 */
export function appSettingsShapeIssue(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "it does not contain a JSON object";
  }
  const { theme, language } = raw as Record<string, unknown>;
  if (theme !== undefined && typeof theme !== "string") {
    return "its `theme` is not a string";
  }
  if (language !== undefined && typeof language !== "string") {
    return "its `language` is not a string";
  }
  return null;
}

/** Builds the settings from known keys only, so retired keys never persist. */
export function normalizeAppSettings(raw: unknown): AppSettings {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    theme: normalizeThemePreference(source.theme),
    language: normalizeLanguagePreference(source.language),
  };
}
