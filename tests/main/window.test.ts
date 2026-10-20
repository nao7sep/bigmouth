// Unit tests for the pure helpers the main window module exports.
//
// Electron is mocked because these helpers need no real window; the parts that
// genuinely require one (the navigation handlers, the load path) are not
// exercised here and do not pretend to be. The one exception is the zoom-key
// listener, reached through createMainWindow on a stand-in window that records
// its listeners, with the UI-state store stubbed at its boundary.

import { afterEach, describe, it, expect, vi } from "vitest";

const zoom = vi.hoisted(() => ({
  // The level Electron's zoom role has left the page at.
  level: 0,
  saved: [] as number[],
  window: null as null | {
    once: Map<string, () => unknown>;
    content: Map<string, (...args: unknown[]) => unknown>;
  },
}));

vi.mock("@main/storageAccess.js", () => ({
  getUiState: async () => ({ zoomLevel: 0 }),
  updateUiState: async (patch: { zoomLevel: number }) => { zoom.saved.push(patch.zoomLevel); },
}));

vi.mock("electron", () => {
  class BrowserWindow {
    readonly onceHandlers = new Map<string, () => unknown>();
    readonly contentHandlers = new Map<string, (...args: unknown[]) => unknown>();
    readonly webContents = {
      on: (event: string, listener: (...args: unknown[]) => unknown) => { this.contentHandlers.set(event, listener); },
      setWindowOpenHandler: () => {},
      setZoomLevel: () => {},
      getZoomLevel: () => zoom.level,
      getZoomFactor: () => 1.2 ** zoom.level,
    };
    constructor() {
      zoom.window = { once: this.onceHandlers, content: this.contentHandlers };
    }
    on(): this { return this; }
    once(event: string, listener: () => unknown): this { this.onceHandlers.set(event, listener); return this; }
    isDestroyed(): boolean { return false; }
    isFocused(): boolean { return false; }
    isMaximized(): boolean { return false; }
    isMinimized(): boolean { return false; }
    isFullScreen(): boolean { return false; }
    getNormalBounds() { return { x: 0, y: 0, width: 1440, height: 900 }; }
    getBounds() { return { x: 0, y: 0, width: 1440, height: 900 }; }
    getContentBounds() { return { x: 0, y: 0, width: 1440, height: 900 }; }
    getMinimumSize(): number[] { return [0, 0]; }
    setMinimumSize(): void {}
    show(): void {}
    async loadFile(): Promise<void> {}
    async loadURL(): Promise<void> {}
  }
  return {
    BrowserWindow,
    Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
    nativeTheme: { themeSource: "system", shouldUseDarkColors: false },
    screen: {
      getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }],
      getDisplayMatching: () => ({ workAreaSize: { width: 1440, height: 900 } }),
      getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }),
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    shell: { openExternal: vi.fn() },
  };
});

import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH, windowMinimumForZoom } from "@shared/layout";
import {
  boundWindowMinimum,
  buildWindowOptions,
  configureWindowActivity,
  createMainWindow,
  isAllowedExternalUrl,
  zoomFactorForLevel,
} from "@main/window.js";
import { CHANNELS } from "@shared/ipc";

const PLATFORM = process.platform;

/** Runs the rest of the test as if on `platform`; afterEach puts the real one back. */
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: PLATFORM });
});

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

  // Only Windows restores the saved maximized (and full-screen) state; the Mac
  // always discards it (window-conventions, Placement).
  it.each([["win32", true], ["darwin", false], ["linux", false]] as const)("persists the main window's display mode on %s: %s", (platform, displayMode) => {
    onPlatform(platform);
    const options = buildWindowOptions();

    expect(options.name).toBe("main");
    expect(options.windowStatePersistence).toEqual({ bounds: true, displayMode });
  });

  it("constructs a restored zoom window with a matching native floor", () => {
    const zoomFactor = zoomFactorForLevel(2);
    const options = buildWindowOptions(zoomFactor);

    expect(zoomFactor).toBeCloseTo(1.44);
    expect(options.webPreferences?.zoomFactor).toBe(zoomFactor);
    const floor = windowMinimumForZoom(zoomFactor);
    expect(options.minWidth).toBe(floor.width);
    expect(options.minHeight).toBe(floor.height);
  });

  it("caps only the native floor when scaled content is larger than the work area", () => {
    const required = { width: 2790, height: 1800 };

    expect(boundWindowMinimum(required, { width: 1512, height: 950 })).toEqual({
      width: 1512,
      height: 950,
    });
    expect(boundWindowMinimum(required, { width: 3200, height: 2000 })).toEqual(required);
    const options = buildWindowOptions(2, { width: 1000, height: 700 });
    expect(options.width).toBe(1000);
    expect(options.height).toBe(700);
    expect(options.minWidth).toBe(1000);
    expect(options.minHeight).toBe(700);
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

// The menu's zoom roles change the page without raising zoom-changed, so the
// window reads the level back after each zoom shortcut. The shortcut's modifier
// is Cmd on macOS and Ctrl elsewhere; the other one is not a zoom shortcut.
describe("zoom shortcuts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Opens the main window and returns its before-input-event listener. */
  async function openZoomedWindow(): Promise<(input: { key: string; meta: boolean; control: boolean }) => void> {
    zoom.level = 0;
    zoom.saved = [];
    await createMainWindow();
    await zoom.window!.once.get("ready-to-show")!();
    // Electron's role runs on the key before the read-back the listener schedules.
    zoom.level = 1;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const listener = zoom.window!.content.get("before-input-event")!;
    return (input) => { listener({}, input); };
  }

  it.each([
    ["darwin", "meta", "control"],
    ["win32", "control", "meta"],
    ["linux", "control", "meta"],
  ] as const)("on %s saves the level after %s with a zoom key, and ignores %s", async (platform, modifier, other) => {
    onPlatform(platform);
    const press = await openZoomedWindow();

    press({ key: "=", meta: other === "meta", control: other === "control" });
    expect(vi.getTimerCount()).toBe(0);

    press({ key: "=", meta: modifier === "meta", control: modifier === "control" });
    expect(vi.getTimerCount()).toBe(1);
    await vi.runOnlyPendingTimersAsync();
    await vi.waitFor(() => expect(zoom.saved).toEqual([1]));
  });

  it("ignores the modifier with a key that is not a zoom key", async () => {
    onPlatform("darwin");
    const press = await openZoomedWindow();

    press({ key: "s", meta: true, control: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
