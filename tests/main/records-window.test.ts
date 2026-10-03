// The records window: one durable secondary window with its own placement,
// brought forward when opened again, and told when a record is stored.
//
// Electron is mocked: these check the app's own decisions (options, identity,
// single instance, the stored-record signal), not the window manager.

import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  created: [] as FakeWindow[],
  clearPersistedState: vi.fn(),
  normalBounds: { x: 100, y: 100, width: 1240, height: 820 },
}));

type FakeWindow = {
  options: Electron.BrowserWindowConstructorOptions;
  handlers: Map<string, () => void>;
  destroyed: boolean;
  minimized: boolean;
  shows: number;
  focuses: number;
  restores: number;
  sent: string[];
};

vi.mock("electron", () => {
  class BrowserWindow {
    static clearPersistedState = electron.clearPersistedState;
    state: FakeWindow;
    webContents: { send: (channel: string) => void; isDestroyed: () => boolean };
    constructor(options: Electron.BrowserWindowConstructorOptions) {
      this.state = {
        options, handlers: new Map(), destroyed: false, minimized: false, shows: 0, focuses: 0, restores: 0, sent: [],
      };
      electron.created.push(this.state);
      this.webContents = {
        send: (channel) => this.state.sent.push(channel),
        isDestroyed: () => this.state.destroyed,
      };
    }
    once(event: string, handler: () => void) { this.state.handlers.set(event, handler); }
    on(event: string, handler: () => void) { this.state.handlers.set(event, handler); }
    getNormalBounds() { return electron.normalBounds; }
    isDestroyed() { return this.state.destroyed; }
    destroy() { this.state.destroyed = true; }
    isMinimized() { return this.state.minimized; }
    restore() { this.state.restores++; }
    show() { this.state.shows++; }
    focus() { this.state.focuses++; }
  }
  return {
    BrowserWindow,
    nativeTheme: { shouldUseDarkColors: false },
    screen: {
      getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }),
      getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }],
    },
  };
});

const loads = vi.hoisted(() => ({ pages: [] as string[], failure: null as Error | null }));

vi.mock("@main/window.js", () => ({
  boundWindowMinimum: (required: { width: number; height: number }, area: { width: number; height: number }) => ({
    width: Math.min(required.width, area.width),
    height: Math.min(required.height, area.height),
  }),
  configureWindowActivity: () => {},
  loadRendererPage: async (_window: unknown, page: string) => {
    loads.pages.push(page);
    if (loads.failure) throw loads.failure;
  },
}));
vi.mock("@main/i18n.js", () => ({ mainTranslator: () => ({ t: () => "Records" }) }));
vi.mock("@main/core/services/logger.js", () => ({ warn: () => {}, serializeError: (err: unknown) => err }));

import { CHANNELS } from "@shared/ipc";
import { RECORDS_WINDOW_MIN_HEIGHT, RECORDS_WINDOW_MIN_WIDTH } from "@shared/layout";

async function freshModule() {
  vi.resetModules();
  return import("@main/records-window.js");
}

beforeEach(() => {
  electron.created.length = 0;
  electron.clearPersistedState.mockReset();
  electron.normalBounds = { x: 100, y: 100, width: 1240, height: 820 };
  loads.pages.length = 0;
  loads.failure = null;
});

describe("records window options", () => {
  it("is a hardened, hidden, durable window with its own placement and a derived minimum", async () => {
    const { buildRecordsWindowOptions } = await freshModule();
    const options = buildRecordsWindowOptions("Records");

    expect(options).toMatchObject({
      name: "records",
      windowStatePersistence: { bounds: true, displayMode: process.platform === "win32" },
      title: "Records",
      show: false,
      minWidth: RECORDS_WINDOW_MIN_WIDTH,
      minHeight: RECORDS_WINDOW_MIN_HEIGHT,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
  });

  it("fits its designed size and minimum inside a small work area", async () => {
    const { buildRecordsWindowOptions } = await freshModule();
    const options = buildRecordsWindowOptions("Records", { width: 700, height: 250 });
    expect(options).toMatchObject({ width: 700, height: 250, minWidth: 700, minHeight: 250 });
  });
});

describe("openRecordsWindow", () => {
  it("opens one window on the records page, and brings it forward when opened again", async () => {
    const { openRecordsWindow } = await freshModule();
    await openRecordsWindow();
    expect(electron.created).toHaveLength(1);
    expect(loads.pages).toEqual(["records.html"]);

    const [window] = electron.created;
    window!.handlers.get("ready-to-show")!();
    window!.minimized = true;
    await openRecordsWindow();

    expect(electron.created).toHaveLength(1);
    expect(window).toMatchObject({ restores: 1, shows: 2, focuses: 1 });
  });

  it("opens a new window once the last one has closed", async () => {
    const { openRecordsWindow } = await freshModule();
    await openRecordsWindow();
    electron.created[0]!.handlers.get("closed")!();
    electron.created[0]!.destroyed = true;
    await openRecordsWindow();
    expect(electron.created).toHaveLength(2);
  });

  it("falls back to the ordinary placement when the saved one is off-screen", async () => {
    electron.normalBounds = { x: 5000, y: 5000, width: 1240, height: 820 };
    const { openRecordsWindow } = await freshModule();
    await openRecordsWindow();

    expect(electron.clearPersistedState).toHaveBeenCalledWith("records");
    expect(electron.created).toHaveLength(2);
    expect(electron.created[0]!.destroyed).toBe(true);
  });

  it("leaves no window behind when its page cannot load", async () => {
    loads.failure = new Error("EACCES");
    const { openRecordsWindow } = await freshModule();
    await expect(openRecordsWindow()).rejects.toThrow("EACCES");
    expect(electron.created[0]!.destroyed).toBe(true);
  });
});

describe("notifyRecordsChanged", () => {
  it("tells the open records window, and nothing when none is open", async () => {
    const { notifyRecordsChanged, openRecordsWindow } = await freshModule();
    notifyRecordsChanged();
    await openRecordsWindow();
    notifyRecordsChanged();
    expect(electron.created[0]!.sent).toEqual([CHANNELS.recordsChanged]);
  });
});
