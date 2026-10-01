// Pure rules for the app-wide settings in the storage root's config.json,
// shared by the main-process store and the renderer's Settings form.

import type { AppSettings, ThemePreference } from "./types.js";
import type { MessageKey } from "./i18n/catalogues.js";
import { isLanguage, normalizeLanguagePreference } from "./i18n/languages.js";

export const APP_SETTINGS_SET_KEYS = ["theme", "language"] as const;

export function appSettingsSetHasShape(key: keyof AppSettings, value: unknown): boolean {
  return key === "theme"
    ? value === "system" || value === "light" || value === "dark"
    : value === "system" || isLanguage(value);
}

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
 * non-object is corruption. Individual sets are validated separately; absent
 * or invalid sets use their built-ins without quarantining the file.
 */
export function appSettingsShapeIssue(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "it does not contain a JSON object";
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
