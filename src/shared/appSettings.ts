// Pure rules for the app-wide settings in the storage root's config.json,
// shared by the main-process store and the renderer's Settings form.

import type { AppSettings, ThemePreference } from "./types.js";

export const THEME_PREFERENCES: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function defaultAppSettings(): AppSettings {
  return { theme: "system" };
}

/** A missing or unrecognized theme follows the OS. */
export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/**
 * Why a parsed config.json cannot be used as-is, or null when it can. A
 * non-object or a wrong-typed present field is corruption: coercing it and then
 * saving would silently destroy what the user wrote (storage-path conventions).
 * An absent field takes its default, and an unrecognized theme name follows the
 * OS, like any other value-level normalization.
 */
export function appSettingsShapeIssue(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "it does not contain a JSON object";
  }
  const theme = (raw as Record<string, unknown>).theme;
  if (theme !== undefined && typeof theme !== "string") {
    return "its `theme` is not a string";
  }
  return null;
}

/** Builds the settings from known keys only, so retired keys never persist. */
export function normalizeAppSettings(raw: unknown): AppSettings {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { theme: normalizeThemePreference(source.theme) };
}
