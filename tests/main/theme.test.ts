import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { themeTokens } from "../appStylesheet";

const electron = vi.hoisted(() => {
  const windows: Array<{ setBackgroundColor: ReturnType<typeof vi.fn>; isDestroyed: () => boolean }> = [];
  const listeners: Record<string, () => void> = {};
  const nativeTheme = {
    themeSource: "system" as string,
    shouldUseDarkColors: false,
    on: vi.fn((event: string, listener: () => void) => {
      listeners[event] = listener;
    }),
  };
  const defaults: Record<string, string> = {};
  return { windows, listeners, nativeTheme, defaults };
});

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => electron.windows },
  nativeTheme: electron.nativeTheme,
  systemPreferences: { getUserDefault: (key: string) => electron.defaults[key] ?? "" },
}));

import { applyThemePreference, followOsThemeChanges, systemAppearance, windowBackground } from "@main/theme.js";

beforeEach(() => {
  electron.windows.splice(0);
  electron.nativeTheme.themeSource = "system";
  electron.nativeTheme.shouldUseDarkColors = false;
  delete electron.defaults.AppleInterfaceStyle;
});

const PLATFORM = process.platform;
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}
afterEach(() => {
  Object.defineProperty(process, "platform", { value: PLATFORM });
});

function fakeWindow() {
  const window = { setBackgroundColor: vi.fn(), isDestroyed: () => false };
  electron.windows.push(window);
  return window;
}

describe("theme", () => {
  it("hands the saved choice to Electron as the one theme authority", () => {
    applyThemePreference("dark");
    expect(electron.nativeTheme.themeSource).toBe("dark");
    applyThemePreference("system");
    expect(electron.nativeTheme.themeSource).toBe("system");
  });

  it("repaints every window's background in the resolved theme", () => {
    const window = fakeWindow();
    electron.nativeTheme.shouldUseDarkColors = true;
    applyThemePreference("dark");
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(windowBackground(true));
  });

  it("follows an OS appearance change under System", () => {
    const window = fakeWindow();
    followOsThemeChanges();
    electron.nativeTheme.shouldUseDarkColors = true;
    electron.listeners.updated?.();
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(windowBackground(true));
  });

  it("uses App.css's --bm-bg in each theme so the frame behind the page never flashes", () => {
    expect(windowBackground(false)).toBe(themeTokens.light.get("--bm-bg")?.toLowerCase());
    expect(windowBackground(true)).toBe(themeTokens.dark.get("--bm-bg")?.toLowerCase());
  });
});

// What Settings shows beside System: the OS appearance, whatever the app applied.
describe("the System appearance", () => {
  it("reads macOS's own appearance even under a saved Light or Dark", () => {
    onPlatform("darwin");
    applyThemePreference("light");
    electron.defaults.AppleInterfaceStyle = "Dark";
    expect(systemAppearance()).toBe("dark");
    delete electron.defaults.AppleInterfaceStyle;
    expect(systemAppearance()).toBe("light");
  });

  it("keeps the appearance last seen under System once a fixed theme is applied elsewhere", () => {
    onPlatform("win32");
    electron.nativeTheme.shouldUseDarkColors = true; // System, OS dark
    applyThemePreference("light");
    electron.nativeTheme.shouldUseDarkColors = false; // Electron now reports Light
    expect(systemAppearance()).toBe("dark");
  });

  it("follows the OS live while the app is on System", () => {
    onPlatform("linux");
    electron.nativeTheme.themeSource = "system";
    electron.nativeTheme.shouldUseDarkColors = false;
    expect(systemAppearance()).toBe("light");
    electron.nativeTheme.shouldUseDarkColors = true;
    expect(systemAppearance()).toBe("dark");
  });
});
