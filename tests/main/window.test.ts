// Unit tests for the two pure helpers window.ts exports. Their comments have
// always said they are "exported so ... a unit test" covers them; no such test
// existed, and the claim is load-bearing — it is why nobody wrote one.
//
// Electron is mocked because these helpers need no real window; the parts that
// genuinely require one (the navigation handlers, the load path) are not
// exercised here and do not pretend to be.

import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
  nativeTheme: { themeSource: "light" },
  screen: {
    getDisplayMatching: () => ({ workAreaSize: { width: 1440, height: 900 } }),
    getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  shell: { openExternal: vi.fn() },
}));

import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from "@shared/layout";
import {
  boundWindowMinimum,
  buildWindowOptions,
  configureWindowActivity,
  isAllowedExternalUrl,
  zoomFactorForLevel,
} from "@main/window.js";
import { CHANNELS } from "@shared/ipc";

describe("isAllowedExternalUrl", () => {
  it("allows the three schemes a link in a post can legitimately use", () => {
    expect(isAllowedExternalUrl("https://example.com/post")).toBe(true);
    expect(isAllowedExternalUrl("http://example.com/post")).toBe(true);
    expect(isAllowedExternalUrl("mailto:someone@example.com")).toBe(true);
  });

  it("refuses everything else, including the schemes that reach the local machine", () => {
    // A post's markdown is user content, and on a local-first app it can name
    // anything at all; handing one of these to the OS is handing it a program.
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vscode://file/etc/passwd",
      "smb://server/share",
      "bigmouth-asset://asset/w/p/x.png",
    ]) {
      expect(isAllowedExternalUrl(url)).toBe(false);
    }
  });

  it("refuses a string that is not a URL at all, rather than throwing", () => {
    expect(isAllowedExternalUrl("")).toBe(false);
    expect(isAllowedExternalUrl("not a url")).toBe(false);
    expect(isAllowedExternalUrl("/just/a/path")).toBe(false);
  });
});

describe("buildWindowOptions", () => {
  it("hardens the renderer: isolated, no node, sandboxed, behind the preload", () => {
    const { webPreferences } = buildWindowOptions();

    expect(webPreferences?.contextIsolation).toBe(true);
    expect(webPreferences?.nodeIntegration).toBe(false);
    expect(webPreferences?.sandbox).toBe(true);
    expect(webPreferences?.preload).toMatch(/preload[/\\]index\.cjs$/);
  });

  it("derives its minimums from the shared layout rather than typing them again", () => {
    const options = buildWindowOptions();

    expect(options.minWidth).toBe(WINDOW_MIN_WIDTH);
    expect(options.minHeight).toBe(WINDOW_MIN_HEIGHT);
    // And the default size actually fits inside them.
    expect(options.width).toBeGreaterThanOrEqual(WINDOW_MIN_WIDTH);
    expect(options.height).toBeGreaterThanOrEqual(WINDOW_MIN_HEIGHT);
  });

  it("constructs a restored zoom window with a matching native floor", () => {
    const zoomFactor = zoomFactorForLevel(2);
    const options = buildWindowOptions(zoomFactor);

    expect(zoomFactor).toBeCloseTo(1.44);
    expect(options.webPreferences?.zoomFactor).toBe(zoomFactor);
    expect(options.minWidth).toBe(Math.ceil(WINDOW_MIN_WIDTH * zoomFactor));
    expect(options.minHeight).toBe(Math.ceil(WINDOW_MIN_HEIGHT * zoomFactor));
  });

  it("caps only the native floor when scaled content is larger than the work area", () => {
    const required = { width: 2790, height: 1800 };

    expect(boundWindowMinimum(required, { width: 1512, height: 950 })).toEqual({
      width: 1512,
      height: 950,
    });
    expect(boundWindowMinimum(required, { width: 3200, height: 2000 })).toEqual(required);
  });

  it("opens hidden, so the first paint is never a blank white window", () => {
    expect(buildWindowOptions().show).toBe(false);
    expect(buildWindowOptions().backgroundColor).toBeTruthy();
  });
});

describe("native window activity transport", () => {
  it("publishes BrowserWindow focus, blur, and the post-load initial state", () => {
    const windowListeners = new Map<string, () => void>();
    const contentListeners = new Map<string, () => void>();
    const send = vi.fn();
    let focused = false;
    let destroyed = false;
    const window = {
      on: vi.fn((event: string, listener: () => void) => {
        windowListeners.set(event, listener);
        return window;
      }),
      isFocused: () => focused,
      webContents: {
        on: vi.fn((event: string, listener: () => void) => {
          contentListeners.set(event, listener);
        }),
        isDestroyed: () => destroyed,
        send,
      },
    };

    configureWindowActivity(window as unknown as Electron.BrowserWindow);
    contentListeners.get("did-finish-load")?.();
    expect(send).toHaveBeenLastCalledWith(CHANNELS.windowActivityChanged, false);
    focused = true;
    windowListeners.get("focus")?.();
    expect(send).toHaveBeenLastCalledWith(CHANNELS.windowActivityChanged, true);
    windowListeners.get("blur")?.();
    expect(send).toHaveBeenLastCalledWith(CHANNELS.windowActivityChanged, false);

    destroyed = true;
    windowListeners.get("focus")?.();
    expect(send).toHaveBeenCalledTimes(3);
  });
});
