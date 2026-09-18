import { describe, it, expect } from "vitest";
import {
  THEME_PREFERENCES,
  appSettingsShapeIssue,
  defaultAppSettings,
  normalizeAppSettings,
  normalizeThemePreference,
} from "@shared/appSettings";

describe("app settings rules", () => {
  it("defaults the theme to System and offers System, Light, and Dark in order", () => {
    expect(defaultAppSettings()).toEqual({ theme: "system" });
    expect(THEME_PREFERENCES.map(({ value }) => value)).toEqual(["system", "light", "dark"]);
  });

  it("follows the OS for a missing or unrecognized theme", () => {
    expect(normalizeThemePreference("dark")).toBe("dark");
    expect(normalizeThemePreference("light")).toBe("light");
    for (const value of [undefined, "", "Dark", "sepia", "system"]) {
      expect(normalizeThemePreference(value)).toBe("system");
    }
  });

  it("builds settings from known keys only", () => {
    expect(normalizeAppSettings({ theme: "dark", retired: true })).toEqual({ theme: "dark" });
    expect(normalizeAppSettings({})).toEqual({ theme: "system" });
  });

  it("treats a non-object or a wrong-typed theme as corruption, never as a value to coerce", () => {
    expect(appSettingsShapeIssue({ theme: "dark" })).toBeNull();
    expect(appSettingsShapeIssue({})).toBeNull();
    expect(appSettingsShapeIssue({ theme: "sepia" })).toBeNull();
    expect(appSettingsShapeIssue([])).not.toBeNull();
    expect(appSettingsShapeIssue(null)).not.toBeNull();
    expect(appSettingsShapeIssue({ theme: true })).not.toBeNull();
  });
});
