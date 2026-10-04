// The quit path (src/main/index.ts): what becomes of text that is still only in
// the post store's write-behind buffer when the app is asked to close.
//
// Everything index.ts pulls in is mocked EXCEPT the post store, so the flush at
// quit is the real one. That is the point: the store's own tests stop at its
// API, and the failure this guards — the app exiting while the editor still
// showed unsaved text — only exists once the two are wired together.
//
// Each test re-imports index.ts through vi.resetModules() so its module-level
// shutdown flags start clean; the mocks' capture maps live in the test file and
// survive the reset.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const appHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const windowHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const powerHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const processHandlers = new Map<string, (error: unknown) => void>();
const MAIN_WINDOW_ID = vi.hoisted(() => 7);
const shell = vi.hoisted(() => ({
  exits: [] as number[],
  quitRequests: 0,
  ownsInstance: true,
  windows: [] as { isMinimized: () => boolean; restore: () => void; focus: () => void }[],
  mainWindow: { minimized: false, restores: 0, focuses: 0 },
  dialogs: [] as { detail?: string }[],
  // What the user clicks in the unsaved-changes dialog: 0 = Cancel (the default).
  dialogChoice: 0,
  // When set, the dialog stays open until the test answers it.
  dialogAnswer: null as Promise<number> | null,
  windowLoadFailure: null as Error | null,
  windowCloses: 0,
  loggedErrors: [] as unknown[][],
}));

vi.mock("electron", () => ({
  app: {
    setName: () => {},
    requestSingleInstanceLock: () => shell.ownsInstance,
    getVersion: () => "0.0.0-test",
    getPreferredSystemLanguages: () => ["en-US"],
    getSystemLocale: () => "en-US",
    whenReady: () => Promise.resolve(),
    on: (event: string, cb: (...args: unknown[]) => unknown) => appHandlers.set(event, cb),
    quit: () => { shell.quitRequests++; },
    exit: (code: number) => shell.exits.push(code),
  },
  systemPreferences: { setUserDefault: () => {}, removeUserDefault: () => {} },
  BrowserWindow: { getAllWindows: () => shell.windows },
  powerMonitor: {
    on: (event: string, cb: (...args: unknown[]) => unknown) => powerHandlers.set(event, cb),
  },
}));

vi.mock("@main/plain-message-dialog.js", () => ({
  showPlainMessageDialog: async (options: { detail?: string }) => {
    shell.dialogs.push(options);
    return shell.dialogAnswer ?? shell.dialogChoice;
  },
}));

vi.mock("@main/window.js", () => ({
  createMainWindow: () => shell.windowLoadFailure ? Promise.reject(shell.windowLoadFailure) : Promise.resolve({
    on: (event: string, cb: (...args: unknown[]) => unknown) => windowHandlers.set(event, cb),
    webContents: { id: MAIN_WINDOW_ID },
    isDestroyed: () => false,
    close: () => { shell.windowCloses++; },
    isMinimized: () => shell.mainWindow.minimized,
    restore: () => { shell.mainWindow.restores++; },
    focus: () => { shell.mainWindow.focuses++; },
  }),
}));
vi.mock("@main/ipc/index.js", () => ({ registerIpcHandlers: () => {} }));
vi.mock("@main/assetProtocol.js", () => ({
  registerAssetScheme: () => {},
  handleAssetProtocol: () => {},
}));
vi.mock("@main/menu.js", () => ({ installApplicationMenu: () => {} }));
vi.mock("@main/core/services/stateStore.js", () => ({ initStateStore: () => {} }));
vi.mock("@main/core/services/appSettingsStore.js", () => ({
  initAppSettingsStore: () => ({ theme: "system", language: "system" }),
}));
vi.mock("@main/theme.js", () => ({
  applyThemePreference: () => {},
  followOsThemeChanges: () => {},
}));
vi.mock("@main/core/services/logger.js", () => ({
  initLogger: () => {},
  closeLogger: () => {},
  getRecordsPath: () => null,
  isDebugLoggingEnabled: () => false,
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: (...args: unknown[]) => { shell.loggedErrors.push(args); },
}));

type PostStore = typeof import("@main/core/services/postStore.js");

let home: string;
let dataDir: string;
const SAVED_HOME = process.env.BIGMOUTH_DATA_DIR;
const processOn = process.on.bind(process);
let processOnSpy: MockInstance<typeof process.on>;

// Each boot owns fresh app hooks, just like the Electron doubles above. Keep
// them off the real process so Vitest alone owns run-level failure reporting.
beforeAll(() => {
  processOnSpy = vi.spyOn(process, "on").mockImplementation((event, listener) => {
    if (event === "uncaughtException" || event === "unhandledRejection") {
      processHandlers.set(event, listener);
      return process;
    }
    return processOn(event, listener);
  });
});

afterAll(() => {
  processOnSpy.mockRestore();
});

/**
 * Boots a fresh copy of the app entry against a fresh workspace directory and
 * returns the same post-store instance index.ts flushes at quit.
 */
async function bootApp(): Promise<PostStore> {
  vi.resetModules();
  appHandlers.clear();
  windowHandlers.clear();
  powerHandlers.clear();
  shell.exits.length = 0;
  shell.quitRequests = 0;
  shell.ownsInstance = true;
  shell.windows.length = 0;
  shell.mainWindow = { minimized: false, restores: 0, focuses: 0 };
  shell.dialogs.length = 0;
  shell.dialogChoice = 0;
  shell.dialogAnswer = null;
  shell.windowLoadFailure = null;
  shell.windowCloses = 0;
  shell.loggedErrors.length = 0;

  const store = (await import("@main/core/services/postStore.js")) as PostStore;
  const { initializeWorkspaceData } = await import("@main/core/services/dataDir.js");
  initializeWorkspaceData(dataDir);

  await import("@main/index.js");
  // bootstrap() runs off app.whenReady(); the window wiring marks it done.
  await vi.waitFor(() => expect(windowHandlers.has("session-end")).toBe(true));
  return store;
}

/** Runs the app's before-quit handler the way Electron would. */
async function quit(): Promise<void> {
  const handler = appHandlers.get("before-quit");
  expect(handler, "before-quit was never registered").toBeTruthy();
  handler!({ preventDefault: () => {} });
  await vi.waitFor(() => {
    if (shell.dialogs.length === 0 && shell.exits.length === 0) throw new Error("quit is still settling");
  });
}

beforeEach(() => {
  processHandlers.clear();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-quit-"));
  process.env.BIGMOUTH_DATA_DIR = home;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-quit-ws-"));
});

afterEach(async () => {
  // vi.resetModules() gives this file a fresh backup-store singleton, distinct
  // from the one closed by tests/main/setup.ts. Close the active instance before
  // removing its throwaway BIGMOUTH_DATA_DIR (Windows keeps the SQLite file locked).
  const { closeBackupStore } = await import("@main/core/services/backupStore.js");
  closeBackupStore();
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("quit flushes the write-behind buffer", () => {
  it("writes buffered text to disk and exits", async () => {
    const store = await bootApp();
    const post = store.createPost(dataDir, "blogger", "en");
    store.queueContent(dataDir, post.frontMatter.id, "typed a moment before quitting");

    await quit();

    // Raw read, bypassing the store: what is durable, not what it reports.
    expect(fs.readFileSync(post.filePath, "utf8")).toContain("typed a moment before quitting");
    expect(shell.dialogs).toEqual([]);
    expect(shell.exits).toEqual([0]);
  });

  it("stops and asks when a post's file vanished, instead of exiting in silence", async () => {
    const store = await bootApp();
    const post = store.createPost(dataDir, "blogger", "en");
    store.queueContent(dataDir, post.frontMatter.id, "work that cannot be written");
    // The file goes out of band (a sync client, a Finder move, a git checkout).
    fs.unlinkSync(post.filePath);

    await quit();

    expect(shell.dialogs).toHaveLength(1);
    expect(shell.dialogs[0].detail).toContain("copy your text somewhere safe");
    // Cancel is the default: the app stays open with the text still on screen.
    expect(shell.exits).toEqual([]);
  });

  it("never blocks when the OS is ending the session (Windows session-end)", async () => {
    const store = await bootApp();
    const post = store.createPost(dataDir, "blogger", "en");
    store.queueContent(dataDir, post.frontMatter.id, "work that cannot be written");
    fs.unlinkSync(post.filePath);

    // Windows raises session-end on the window; there is no app-level event.
    windowHandlers.get("session-end")!({ reasons: ["logoff"] });
    await quit();

    // A dialog here would block until Windows force-terminated the app, losing
    // the buffer — exactly what the escape hatch exists to prevent.
    expect(shell.dialogs).toEqual([]);
    expect(shell.exits).toEqual([0]);
  });

  it("never blocks on the macOS/Linux shutdown signal either", async () => {
    const store = await bootApp();
    const post = store.createPost(dataDir, "blogger", "en");
    store.queueContent(dataDir, post.frontMatter.id, "work that cannot be written");
    fs.unlinkSync(post.filePath);

    powerHandlers.get("shutdown")!();
    await quit();

    expect(shell.dialogs).toEqual([]);
    expect(shell.exits).toEqual([0]);
  });
});

// A metadata value the store refused (an invalid or taken slug) was never
// buffered, so it lives only on screen. The screen showed it; quitting or
// closing must not silently keep the last accepted value instead.
describe("a refused metadata value on screen", () => {
  async function refuseInMainWindow(): Promise<void> {
    const { setMetadataRefusal } = await import("@main/ipc/refusedMetadata.js");
    setMetadataRefusal({ id: MAIN_WINDOW_ID, once: () => {}, on: () => {} }, "p1", true);
  }

  it("asks before quitting, and Cancel keeps the app open", async () => {
    await bootApp();
    await refuseInMainWindow();

    await quit();

    expect(shell.dialogs).toHaveLength(1);
    expect(shell.dialogs[0].detail).toContain("refused");
    expect(shell.exits).toEqual([]);
  });

  it("quits when the user chooses Quit Anyway", async () => {
    await bootApp();
    await refuseInMainWindow();
    shell.dialogChoice = 1;

    await quit();
    await vi.waitFor(() => expect(shell.exits).toEqual([0]));
  });

  it("holds the window close until the user chooses, then closes on Close Anyway", async () => {
    await bootApp();
    await refuseInMainWindow();
    const preventDefault = vi.fn();

    windowHandlers.get("close")!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(shell.dialogs).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shell.windowCloses).toBe(0);

    shell.dialogChoice = 1;
    windowHandlers.get("close")!({ preventDefault });
    await vi.waitFor(() => expect(shell.windowCloses).toBe(1));
    // The refusal is forgotten, so the close that follows goes through.
    const again = vi.fn();
    windowHandlers.get("close")!({ preventDefault: again });
    expect(again).not.toHaveBeenCalled();
  });

  it("closes without asking when nothing on screen was refused", async () => {
    await bootApp();
    const preventDefault = vi.fn();
    windowHandlers.get("close")!({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(shell.dialogs).toEqual([]);
  });
});

// Electron raises before-quit again for a second Cmd+Q, a Dock quit or a
// window-all-closed while the first is still shutting down. Letting that one
// through ended the process before the shutdown it interrupted had finished.
describe("a quit while shutdown runs", () => {
  it("is held, and only the shutdown's own exit ends the process", async () => {
    await bootApp();
    const { setMetadataRefusal } = await import("@main/ipc/refusedMetadata.js");
    setMetadataRefusal({ id: MAIN_WINDOW_ID, once: () => {}, on: () => {} }, "p1", true);
    let answer!: (choice: number) => void;
    shell.dialogAnswer = new Promise((resolve) => { answer = resolve; });
    const handler = appHandlers.get("before-quit")!;

    const first = vi.fn();
    handler({ preventDefault: first });
    await vi.waitFor(() => expect(shell.dialogs).toHaveLength(1));

    const second = vi.fn();
    handler({ preventDefault: second });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(shell.dialogs).toHaveLength(1);
    expect(shell.exits).toEqual([]);

    answer(1); // Quit Anyway
    await vi.waitFor(() => expect(shell.exits).toEqual([0]));
  });

  it("is held when nothing needs asking, and the process exits once", async () => {
    await bootApp();
    const handler = appHandlers.get("before-quit")!;
    const first = vi.fn();
    const second = vi.fn();
    handler({ preventDefault: first });
    handler({ preventDefault: second });
    expect(second).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(shell.exits).toEqual([0]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shell.exits).toEqual([0]);
  });

  it("is let through again once the user cancelled the first", async () => {
    await bootApp();
    const { setMetadataRefusal } = await import("@main/ipc/refusedMetadata.js");
    setMetadataRefusal({ id: MAIN_WINDOW_ID, once: () => {}, on: () => {} }, "p1", true);
    await quit(); // Cancel
    expect(shell.exits).toEqual([]);

    shell.dialogChoice = 1;
    const again = vi.fn();
    appHandlers.get("before-quit")!({ preventDefault: again });
    await vi.waitFor(() => expect(shell.dialogs).toHaveLength(2));
    await vi.waitFor(() => expect(shell.exits).toEqual([0]));
  });
});

describe("single app-process ownership", () => {
  it("captures app failure hooks across repeated boots without adding process listeners", async () => {
    const events = ["uncaughtException", "unhandledRejection"] as const;
    const original = events.map((event) => process.listeners(event));
    await bootApp();
    await bootApp();

    expect([...processHandlers.keys()]).toEqual(events);
    expect(events.map((event) => process.listeners(event))).toEqual(original);
    processHandlers.get("uncaughtException")!(new Error("exception probe"));
    processHandlers.get("unhandledRejection")!(new Error("rejection probe"));
    expect(shell.loggedErrors).toEqual([
      ["uncaught exception", { error: { message: "exception probe" } }],
      ["unhandled promise rejection", { error: { message: "rejection probe" } }],
    ]);
  });

  it("routes a renderer document-load rejection to the authored startup halt", async () => {
    vi.resetModules();
    appHandlers.clear();
    windowHandlers.clear();
    shell.dialogs.length = 0;
    shell.exits.length = 0;
    shell.loggedErrors.length = 0;
    shell.windowLoadFailure = new Error("EACCES /private/tmp/renderer.html");

    await import("@main/index.js");
    await vi.waitFor(() => expect(shell.dialogs).toHaveLength(1));

    expect(shell.dialogs[0].detail).toContain("No posts or workspace documents were changed");
    expect(JSON.stringify(shell.dialogs[0])).not.toContain("EACCES");
    expect(JSON.stringify(shell.loggedErrors)).toContain("EACCES");
    expect(shell.exits).toEqual([1]);
  });

  it("quits a second process before it can bootstrap process-local workspace state", async () => {
    vi.resetModules();
    appHandlers.clear();
    windowHandlers.clear();
    powerHandlers.clear();
    shell.quitRequests = 0;
    shell.ownsInstance = false;

    await import("@main/index.js");
    await Promise.resolve();

    expect(shell.quitRequests).toBe(1);
    expect(windowHandlers.has("session-end")).toBe(false);
    expect(appHandlers.has("before-quit")).toBe(false);
  });

  it("focuses the main window when another launch is redirected to it", async () => {
    await bootApp();
    // Another window, such as the records window, may be first in the list.
    const other = { isMinimized: vi.fn(() => false), restore: vi.fn(), focus: vi.fn() };
    shell.windows.push(other);
    shell.mainWindow.minimized = true;

    appHandlers.get("second-instance")!();

    expect(shell.mainWindow).toMatchObject({ restores: 1, focuses: 1 });
    expect(other.focus).not.toHaveBeenCalled();
  });

  it("quits off macOS when the main window closes, whatever else is open, and only once", async () => {
    await bootApp();
    const quits = shell.quitRequests;
    windowHandlers.get("closed")!();
    appHandlers.get("window-all-closed")!();
    expect(shell.quitRequests).toBe(process.platform === "darwin" ? quits : quits + 1);
  });
});
