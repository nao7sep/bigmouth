import { BrowserWindow, nativeTheme, systemPreferences } from "electron";
import type { ThemePreference } from "@shared/types";

// Electron's nativeTheme.themeSource is BigMouth's one theme authority
// (app-chrome conventions, Theme): it paints the native title bar, menus, and
// dialogs, and it decides `prefers-color-scheme` in every renderer, which is
// what App.css's dark block and the plain message dialog follow. No renderer
// resolves System itself.

// App.css's --bm-bg in each theme, so the frames before a page paints and the
// backing exposed while resizing already match it.
const LIGHT_BACKGROUND = "#f4efe8";
const DARK_BACKGROUND = "#1d1915";

export function windowBackground(dark: boolean): string {
  return dark ? DARK_BACKGROUND : LIGHT_BACKGROUND;
}

function syncWindowBackgrounds(): void {
  const color = windowBackground(nativeTheme.shouldUseDarkColors);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setBackgroundColor(color);
  }
}

// The OS appearance as last seen while the app followed it. Once a saved Light
// or Dark is applied, Electron reports that choice instead, so this is what
// Windows and Linux fall back to; it goes stale only if the OS changes while
// BigMouth runs with a fixed theme.
let lastSystemDark: boolean | null = null;

function noteSystemAppearance(): void {
  if (nativeTheme.themeSource === "system") lastSystemDark = nativeTheme.shouldUseDarkColors;
}

/**
 * What System would resolve to now, for Settings to show beside it
 * (app-chrome conventions, Theme). macOS reports its appearance directly,
 * whatever theme the app has applied.
 */
export function systemAppearance(): "light" | "dark" {
  if (process.platform === "darwin") {
    return systemPreferences.getUserDefault("AppleInterfaceStyle", "string") === "Dark" ? "dark" : "light";
  }
  noteSystemAppearance();
  return lastSystemDark ? "dark" : "light";
}

/** Applies a saved choice to the whole app; System follows the OS. */
export function applyThemePreference(preference: ThemePreference): void {
  noteSystemAppearance();
  nativeTheme.themeSource = preference;
  syncWindowBackgrounds();
}

/** Keeps window backgrounds in step when the OS appearance changes under System. */
export function followOsThemeChanges(): void {
  nativeTheme.on("updated", () => {
    noteSystemAppearance();
    syncWindowBackgrounds();
  });
}
