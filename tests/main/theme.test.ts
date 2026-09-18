import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

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
  return { windows, listeners, nativeTheme };
});

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => electron.windows },
  nativeTheme: electron.nativeTheme,
}));

import { applyThemePreference, followOsThemeChanges, windowBackground } from "@main/theme.js";

beforeEach(() => {
  electron.windows.splice(0);
  electron.nativeTheme.themeSource = "system";
  electron.nativeTheme.shouldUseDarkColors = false;
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
    const css = readFileSync(`${process.cwd()}/src/renderer/src/App.css`, "utf8");
    const light = css.slice(css.search(/^:root\s*\{/m));
    const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark) {"));
    const bg = (block: string) => block.match(/--bm-bg:\s*(#[0-9a-f]{6});/i)?.[1]?.toLowerCase();
    expect(windowBackground(false)).toBe(bg(light));
    expect(windowBackground(true)).toBe(bg(dark));
  });
});
