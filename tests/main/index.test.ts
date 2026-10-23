// The quit path (src/main/index.ts): what becomes of text that is still only in
// the post store's write-behind buffer when the app is asked to close.
//
// Everything index.ts pulls in is mocked EXCEPT the post store, so the flush at
// quit is the real one. That is the point: the store's own tests stop at its
// API, and the failure this guards — the app exiting while the editor still
// showed unsaved text — only exists once the two are wired together. The one
// seam is the worker thread the app runs that flush on (storageOwner.ts, tested on
// its own): here the same store flush runs in place, or the test makes it
// stall past its bound.
//
// Menu Quit, Cmd+Q and the Dock's Quit all reach the app as before-quit, which
// Electron raises for each; quit() below stands for all three.
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
  startupCalls: [] as string[],
  frameworkPaths: [] as [string, string][],
  nativeErrors: [] as [string, string][],
  nativeErrorFailure: false,
  windows: [] as { isMinimized: () => boolean; restore: () => void; focus: () => void }[],
  mainWindow: { minimized: false, restores: 0, focuses: 0 },
  dialogs: [] as { detail?: string; buttons?: string[] }[],
  // What the user clicks in the unsaved-changes dialog: 0 = Cancel (the default).
  dialogChoice: 0,
  // Answers for the dialogs to come, in order, before dialogChoice applies.
  dialogChoices: [] as number[],
  // When set, the dialog stays open until the test answers it.
  dialogAnswer: null as Promise<number> | null,
  dialogFailure: null as Error | null,
  // Answers an open dialog with its cancel choice, as an ending session does.
  cancelOpenDialog: null as (() => void) | null,
  windowLoadFailure: null as Error | null,
  // How many main windows the app has asked for.
  windowOpens: 0,
  windowCloses: 0,
  loggedErrors: [] as unknown[][],
  // Signals the app sent to its own process: a forced exit, never a real kill here.
  kills: [] as (string | number | undefined)[],
}));

vi.mock("electron", () => ({
  app: {
    setName: () => {},
    setPath: (name: string, directory: string) => {
      shell.startupCalls.push(`setPath:${name}`);
      shell.frameworkPaths.push([name, directory]);
    },
    requestSingleInstanceLock: () => { shell.startupCalls.push("singleton"); return shell.ownsInstance; },
    getVersion: () => "0.0.0-test",
    getPreferredSystemLanguages: () => ["en-US"],
    getSystemLocale: () => "en-US",
    whenReady: () => { shell.startupCalls.push("whenReady"); return Promise.resolve(); },
    on: (event: string, cb: (...args: unknown[]) => unknown) => appHandlers.set(event, cb),
    quit: () => { shell.quitRequests++; },
    getPath: (name: string) => `/os-reported/${name}`,
    exit: (code: number) => shell.exits.push(code),
  },
  dialog: { showErrorBox: (title: string, content: string) => {
    shell.nativeErrors.push([title, content]);
    if (shell.nativeErrorFailure) throw new Error("native error box unavailable");
  } },
  systemPreferences: { setUserDefault: () => {}, removeUserDefault: () => {} },
  BrowserWindow: { getAllWindows: () => shell.windows },
  powerMonitor: {
    on: (event: string, cb: (...args: unknown[]) => unknown) => powerHandlers.set(event, cb),
  },
}));

vi.mock("@main/plain-message-dialog.js", () => ({
  showPlainMessageDialog: async (options: { detail?: string; buttons?: string[] }) => {
    shell.dialogs.push(options);
    if (shell.dialogFailure) throw shell.dialogFailure;
    if (shell.dialogAnswer) {
      return Promise.race([shell.dialogAnswer, new Promise<number>((resolve) => { shell.cancelOpenDialog = () => resolve(0); })]);
    }
    return shell.dialogChoices.shift() ?? shell.dialogChoice;
  },
  cancelOpenMessageDialogs: () => shell.cancelOpenDialog?.(),
}));

// What each flush at quit does, in order: "store" runs the real store's flush in
// place; "stall" stands for a flush still blocked when the bound passes.
const flush = vi.hoisted(() => ({
  plan: [] as ("store" | "stall")[],
  calls: 0,
  // Whether the storage worker finishes within the exit bound.
  finishSettles: true,
  // The backup drain each asynchronous finish was given, in ms.
  backupDrains: [] as number[],
  // How many times exit let the records window's reader go.
  recordsReaderCloses: 0,
  // The Documents folder each storage initialization was handed.
  initializedDocuments: [] as (string | undefined)[],
  store: null as null | Pick<typeof import("@main/core/services/postStore.js"), "flushAllPendingEdits" | "resumePendingFlushes" | "holdPendingFlushes">,
}));
vi.mock("@main/storageOwner.js", () => {
  const flushNow = () => {
    flush.calls++;
    flush.store!.holdPendingFlushes();
    if ((flush.plan.shift() ?? "store") === "stall") return { kind: "expired" };
    return { kind: "flushed", failures: flush.store!.flushAllPendingEdits() };
  };
  return { storageOwner: {
    onRecordStored: () => {}, flushAsync: async () => flushNow(), flushWithin: flushNow,
    finishAsync: async (_boundMs: number, backupDrainMs: number) => { flush.backupDrains.push(backupDrainMs); return flush.finishSettles; },
    finishWithin: () => flush.finishSettles, stop: async () => {},
  } };
});
vi.mock("@main/storageAccess.js", async () => ({
  initialize: async (documentsDirectory?: string) => {
    flush.initializedDocuments.push(documentsDirectory);
    const store = await import("@main/core/services/workspaceStore.js");
    const paths = await import("@main/core/services/storagePaths.js");
    const config = store.initAppDir();
    return { config, settings: { theme: "system", language: "system" }, recordsDbPath: paths.getRecordsDbPath(), recordsPath: null, thumbnailsDir: paths.getThumbnailsDir() };
  },
  listWorkspaces: async () => [],
  log: async () => {},
  resumePendingFlushes: async () => flush.store!.resumePendingFlushes(),
}));

vi.mock("@main/window.js", () => ({
  createMainWindow: () => shell.windowLoadFailure ? Promise.reject(shell.windowLoadFailure) : (shell.windowOpens++, Promise.resolve({
    on: (event: string, cb: (...args: unknown[]) => unknown) => windowHandlers.set(event, cb),
    webContents: { id: MAIN_WINDOW_ID },
    isDestroyed: () => false,
    close: () => { shell.windowCloses++; },
    isMinimized: () => shell.mainWindow.minimized,
    restore: () => { shell.mainWindow.restores++; },
    focus: () => { shell.mainWindow.focuses++; },
  })),
}));
vi.mock("@main/ipc/index.js", () => ({ registerIpcHandlers: () => {} }));
vi.mock("@main/core/services/recordsReader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@main/core/services/recordsReader.js")>();
  return { ...actual, closeRecordsReader: () => { flush.recordsReaderCloses++; actual.closeRecordsReader(); } };
});
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
  setLogSink: () => {},
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

// The first boot transforms index.ts and its whole module graph, several times
// the cost of a later one. It is paid once here, inside the hook's own timeout,
// so no test pays it inside its own (fleet-metadata-code-review checklist, Tests).
beforeAll(async () => {
  const warmHome = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-quit-warm-"));
  const warmData = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-quit-warm-ws-"));
  const savedData = dataDir;
  process.env.BIGMOUTH_DATA_DIR = warmHome;
  dataDir = warmData;
  try {
    await bootApp();
  } finally {
    flush.store?.resumePendingFlushes();
    const { closeBackupStore } = await import("@main/core/services/backupStore.js");
    closeBackupStore();
    if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_DATA_DIR;
    else process.env.BIGMOUTH_DATA_DIR = SAVED_HOME;
    dataDir = savedData;
    fs.rmSync(warmHome, { recursive: true, force: true });
    fs.rmSync(warmData, { recursive: true, force: true });
  }
}, 30_000);

/**
 * Boots a fresh copy of the app entry against a fresh workspace directory and
 * returns the same post-store instance index.ts flushes at quit.
 */
async function bootApp(): Promise<PostStore> {
  // Repeated boots in one test must retire the old recorder before resetting
  // its module owner; otherwise its queued writes race deletion of this root.
  const previousBackup = await import("@main/core/services/backupStore.js");
  await previousBackup.stopBackups(5000);
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
  shell.dialogChoices = [];
  shell.dialogAnswer = null;
  shell.dialogFailure = null;
  shell.cancelOpenDialog = null;
  flush.plan = [];
  flush.calls = 0;
  flush.finishSettles = true;
  flush.backupDrains = [];
  flush.recordsReaderCloses = 0;
  flush.initializedDocuments = [];
  shell.kills.length = 0;
  shell.windowLoadFailure = null;
  shell.windowOpens = 0;
  shell.windowCloses = 0;
  shell.loggedErrors.length = 0;

  const store = (await import("@main/core/services/postStore.js")) as PostStore;
  flush.store = store;
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
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const PLATFORM = process.platform;

/** Runs the rest of the test as if on `platform`; afterEach puts the real one back. */
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

let killSpy: MockInstance<typeof process.kill>;
let consoleErrorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  shell.startupCalls.length = 0;
  shell.frameworkPaths.length = 0;
  shell.nativeErrors.length = 0;
  shell.nativeErrorFailure = false;
  killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => { shell.kills.push(signal); return true; });
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  processHandlers.clear();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-quit-"));
  process.env.BIGMOUTH_DATA_DIR = home;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-quit-ws-"));
});

afterEach(async () => {
  killSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", { value: PLATFORM });
  // A quit the test left unfinished holds the store's writes.
  flush.store?.resumePendingFlushes();
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

// The storage worker cannot reach Electron, so startup asks for the folder the
// OS reports, which follows a Documents folder moved out of the home directory.
describe("startup", () => {
  it("keeps the existing singleton identity and assigns both framework directories before readiness", async () => {
    await bootApp();
    expect(shell.startupCalls).toEqual(["singleton", "setPath:userData", "setPath:sessionData", "whenReady"]);
    expect(shell.frameworkPaths).toEqual([
      ["userData", path.join(home, "electron")],
      ["sessionData", path.join(home, "electron", "session")],
    ]);
  });

  it.each([false, true])("halts before readiness when the framework root fails, even if error reporting fails: %s", async (dialogFails) => {
    vi.resetModules();
    appHandlers.clear();
    windowHandlers.clear();
    powerHandlers.clear();
    shell.exits.length = 0;
    shell.windowOpens = 0;
    shell.nativeErrorFailure = dialogFails;
    fs.writeFileSync(path.join(home, "electron"), "not a directory");
    await import("@main/index.js");
    expect(shell.exits).toEqual([1]);
    expect(shell.nativeErrors).toEqual([[
      "BigMouth could not start", "BigMouth could not finish opening its settings and workspace.",
    ]]);
    expect(shell.startupCalls).toEqual(["singleton"]);
    expect(shell.frameworkPaths).toEqual([]);
    expect(shell.windowOpens).toBe(0);
    expect(appHandlers.size).toBe(0);
    expect(powerHandlers.size).toBe(0);
  });

  it("hands storage the Documents folder Electron reports", async () => {
    await bootApp();
    expect(flush.initializedDocuments).toEqual(["/os-reported/documents"]);
  });
});

describe("quit flushes the write-behind buffer", () => {
  it("cancels a quit whose confirmation fails and releases its busy claim", async () => {
    const store = await bootApp();
    const post = store.createPost(dataDir, "blogger", "en");
    store.queueContent(dataDir, post.frontMatter.id, "still owned");
    flush.plan = ["stall"];
    shell.dialogAnswer = Promise.reject(new Error("dialog could not open"));
    await quit();
    expect(shell.exits).toEqual([]);
    await vi.waitFor(() => expect(JSON.stringify(shell.loggedErrors)).toContain("quit confirmation failed; quit cancelled"));
    shell.dialogAnswer = null;
    await quit();
    expect(shell.exits).toEqual([0]);
    expect(fs.readFileSync(post.filePath, "utf8")).toContain("still owned");
  });

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
    expect(shell.dialogs[0].buttons).toEqual(["Cancel", "Retry", "Quit Anyway"]);
    expect(shell.dialogs[0].detail).toContain("copy your text somewhere safe");
    expect(JSON.stringify(shell.loggedErrors)).toContain("pending edits flush failed at quit");
    // Cancel is the Escape path: the app stays open with the text still on screen.
    expect(shell.exits).toEqual([]);
  });

  it("asks the same when the flush is still blocked once its bound has passed", async () => {
    const store = await bootApp();
    const post = store.createPost(dataDir, "blogger", "en");
    store.queueContent(dataDir, post.frontMatter.id, "stuck behind a stalled disk");
    flush.plan = ["stall"];

    await quit();

    expect(shell.dialogs).toHaveLength(1);
    expect(shell.dialogs[0].buttons).toContain("Retry");
    expect(JSON.stringify(shell.loggedErrors)).toContain("pending edits flush did not finish at quit");
    expect(shell.exits).toEqual([]);
  });

  it("writes again on Retry and quits once the posts are written", async () => {
    const store = await bootApp();
    const post = store.createPost(dataDir, "blogger", "en");
    store.queueContent(dataDir, post.frontMatter.id, "written on the second try");
    flush.plan = ["stall", "store"];
    shell.dialogChoices = [1];

    await quit();
    await vi.waitFor(() => expect(shell.exits).toEqual([0]));

    expect(flush.calls).toBe(2);
    expect(shell.dialogs).toHaveLength(1);
    expect(fs.readFileSync(post.filePath, "utf8")).toContain("written on the second try");
  });

  it("asks again when Retry fails too", async () => {
    const store = await bootApp();
    const post = store.createPost(dataDir, "blogger", "en");
    store.queueContent(dataDir, post.frontMatter.id, "still stuck");
    flush.plan = ["stall", "stall"];
    shell.dialogChoices = [1, 0];

    await quit();
    await vi.waitFor(() => expect(shell.dialogs).toHaveLength(2));

    expect(flush.calls).toBe(2);
    expect(shell.exits).toEqual([]);
  });

  it("exits without the edits on Quit Anyway", async () => {
    const store = await bootApp();
    const post = store.createPost(dataDir, "blogger", "en");
    store.queueContent(dataDir, post.frontMatter.id, "given up");
    flush.plan = ["stall"];
    shell.dialogChoice = 2;

    await quit();
    await vi.waitFor(() => expect(shell.exits).toEqual([0]));
    expect(flush.calls).toBe(1);
  });

  it("holds the store's own writes while it asks, and resumes them when the user cancels", async () => {
    const store = await bootApp();
    const post = store.createPost(dataDir, "blogger", "en");
    store.queueContent(dataDir, post.frontMatter.id, "kept after a cancelled quit");
    flush.plan = ["stall"];
    let answer!: (choice: number) => void;
    shell.dialogAnswer = new Promise((resolve) => { answer = resolve; });

    await quit();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Long past the store's debounce, nothing was written while the question was open.
      store.queueContent(dataDir, post.frontMatter.id, "kept after a cancelled quit");
      vi.advanceTimersByTime(60_000);
      expect(fs.readFileSync(post.filePath, "utf8")).not.toContain("kept after a cancelled quit");

      answer(0); // Cancel
      // Once the cancel lands, the store's debounce writes the text again.
      await vi.waitFor(() => {
        vi.advanceTimersByTime(1_000);
        expect(fs.readFileSync(post.filePath, "utf8")).toContain("kept after a cancelled quit");
      });
      expect(shell.exits).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// An ending OS session never asks: the app writes what it can within the
// flush's bound, logs what it could not, and exits.
describe("an ending OS session", () => {
  it("writes and exits on Windows' session-end, which raises no before-quit", async () => {
    const store = await bootApp();
    const post = store.createPost(dataDir, "blogger", "en");
    store.queueContent(dataDir, post.frontMatter.id, "saved at logoff");

    windowHandlers.get("session-end")!({ reasons: ["logoff"] });

    // Synchronously: the session may end as soon as the handler returns.
    expect(fs.readFileSync(post.filePath, "utf8")).toContain("saved at logoff");
    expect(shell.dialogs).toEqual([]);
    expect(shell.exits).toEqual([0]);
  });

  it("logs and exits on Windows' session-end when the posts cannot be written", async () => {
    const store = await bootApp();
    const post = store.createPost(dataDir, "blogger", "en");
    store.queueContent(dataDir, post.frontMatter.id, "work that cannot be written");
    fs.unlinkSync(post.filePath);

    windowHandlers.get("session-end")!({ reasons: ["logoff"] });

    // A dialog here would block until Windows force-terminated the app.
    expect(shell.dialogs).toEqual([]);
    expect(JSON.stringify(shell.loggedErrors)).toContain("pending edits flush failed at quit");
    expect(shell.exits).toEqual([0]);
  });

  it("saves and exits synchronously at session-end while a quit question remains unanswered", async () => {
    const store = await bootApp();
    const post = store.createPost(dataDir, "blogger", "en");
    flush.plan = ["stall"];
    shell.dialogAnswer = new Promise(() => {});
    await quit();
    expect(shell.dialogs).toHaveLength(1);
    store.queueContent(dataDir, post.frontMatter.id, "typed while the question was open");

    windowHandlers.get("session-end")!({ reasons: ["shutdown"] });

    expect(fs.readFileSync(post.filePath, "utf8")).toContain("typed while the question was open");
    expect(shell.dialogs).toHaveLength(1);
    expect(shell.exits).toEqual([0]);
  });

  it("logs and exits when the flush is still blocked at the bound", async () => {
    const store = await bootApp();
    const post = store.createPost(dataDir, "blogger", "en");
    store.queueContent(dataDir, post.frontMatter.id, "stuck behind a stalled disk");
    flush.plan = ["stall"];

    windowHandlers.get("session-end")!({ reasons: ["shutdown"] });

    expect(shell.dialogs).toEqual([]);
    expect(JSON.stringify(shell.loggedErrors)).toContain("pending edits flush did not finish at quit");
    expect(shell.exits).toEqual([0]);
  });

  it("never asks at a macOS or Linux shutdown, which arrives as before-quit", async () => {
    const store = await bootApp();
    const post = store.createPost(dataDir, "blogger", "en");
    store.queueContent(dataDir, post.frontMatter.id, "work that cannot be written");
    fs.unlinkSync(post.filePath);

    powerHandlers.get("shutdown")!();
    await quit();

    expect(shell.dialogs).toEqual([]);
    expect(JSON.stringify(shell.loggedErrors)).toContain("pending edits flush failed at quit");
    expect(shell.exits).toEqual([0]);
  });

  it("gives pending backup writes part of the bound at an ordinary quit and none at shutdown", async () => {
    await bootApp();
    await quit();
    expect(flush.backupDrains).toEqual([300]);
    expect(flush.recordsReaderCloses).toBe(1);

    await bootApp();
    powerHandlers.get("shutdown")!();
    await quit();
    expect(flush.backupDrains).toEqual([0]);
    expect(flush.recordsReaderCloses).toBe(1);
  });

  it("answers a quit question already open, and exits", async () => {
    const store = await bootApp();
    const post = store.createPost(dataDir, "blogger", "en");
    store.queueContent(dataDir, post.frontMatter.id, "work that cannot be written");
    fs.unlinkSync(post.filePath);
    shell.dialogAnswer = new Promise(() => {}); // the user never answers

    await quit();
    expect(shell.dialogs).toHaveLength(1);

    powerHandlers.get("shutdown")!();
    await vi.waitFor(() => expect(shell.exits).toEqual([0]));
    // The logout's own quit, held while the first one finishes.
    appHandlers.get("before-quit")!({ preventDefault: () => {} });
    expect(shell.dialogs).toHaveLength(1);
    expect(shell.exits).toEqual([0]);
  });
});

// Electron's app.exit never returns while the storage worker is blocked in
// native I/O, so an unsettled worker at the exit bound ends the process instead.
describe("a storage worker still blocked at the exit bound", () => {
  it("ends the process instead of calling app.exit after a user quit", async () => {
    await bootApp();
    flush.finishSettles = false;

    appHandlers.get("before-quit")!({ preventDefault: () => {} });
    await vi.waitFor(() => expect(shell.kills).toEqual(["SIGKILL"]));

    expect(shell.exits).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Storage did not settle"));
  });

  it("ends the process instead of calling app.exit at Windows' session-end", async () => {
    await bootApp();
    flush.finishSettles = false;

    windowHandlers.get("session-end")!({ reasons: ["logoff"] });

    expect(shell.kills).toEqual(["SIGKILL"]);
    expect(shell.exits).toEqual([]);
  });

  it("keeps app.exit when the worker settled", async () => {
    await bootApp();
    await quit();
    expect(shell.kills).toEqual([]);
    expect(shell.exits).toEqual([0]);
  });
});

// Electron reports no cancelled logout, so the shutdown signal covers only a
// quit within 60 seconds of it.
describe("a macOS or Linux shutdown signal with no quit after it", () => {
  it("asks about a failed save again once its window has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T01:00:00.000Z"));
    const store = await bootApp();
    const post = store.createPost(dataDir, "blogger", "en");
    store.queueContent(dataDir, post.frontMatter.id, "work that cannot be written");
    fs.unlinkSync(post.filePath);

    powerHandlers.get("shutdown")!(); // another app then cancels the logout
    vi.setSystemTime(Date.now() + 60_001);
    await quit();

    expect(shell.dialogs).toHaveLength(1);
    expect(shell.exits).toEqual([]);
  });

  it("still never asks for a quit inside its window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T01:00:00.000Z"));
    const store = await bootApp();
    const post = store.createPost(dataDir, "blogger", "en");
    store.queueContent(dataDir, post.frontMatter.id, "work that cannot be written");
    fs.unlinkSync(post.filePath);

    powerHandlers.get("shutdown")!();
    vi.setSystemTime(Date.now() + 59_000);
    await quit();

    expect(shell.dialogs).toEqual([]);
    expect(shell.exits).toEqual([0]);
  });
});

// Off macOS the main window's close is the quit, so it goes through the same
// save and stays open when the user cancels.
// Closing the main window ends the app on every platform, through the quit,
// which saves and asks while the posts are still on screen (window conventions).
describe("closing the main window", () => {
  it.each(["darwin", "win32", "linux"] as const)("is held and becomes the quit on %s", async (platform) => {
    onPlatform(platform);
    await bootApp();
    const preventDefault = vi.fn();

    windowHandlers.get("close")!({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(shell.quitRequests).toBe(1);
    expect(shell.windowCloses).toBe(0);
  });

  it.each(["darwin", "linux"] as const)("asks about a refused metadata value as a quit on %s", async (platform) => {
    onPlatform(platform);
    await bootApp();
    const { setMetadataRefusal } = await import("@main/ipc/refusedMetadata.js");
    setMetadataRefusal({ id: MAIN_WINDOW_ID, once: () => {}, on: () => {} }, "p1", true);

    windowHandlers.get("close")!({ preventDefault: () => {} });
    await quit(); // the before-quit that app.quit() raises

    expect(shell.dialogs).toHaveLength(1);
    expect(shell.dialogs[0].buttons).toEqual(["Cancel", "Quit Anyway"]);
    expect(shell.exits).toEqual([]);
  });

  it("is let through when the OS session is ending", async () => {
    onPlatform("win32");
    await bootApp();
    windowHandlers.get("session-end")!({ reasons: ["logoff"] });
    const preventDefault = vi.fn();
    windowHandlers.get("close")!({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
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

});

// Quitting stops a paid AI request still running, so a quit the user started
// asks first; an ending OS session never asks.
describe("a running AI request at quit", () => {
  async function startRequest(): Promise<() => void> {
    const { trackAiRequest } = await import("@main/ipc/aiRequests.js");
    return trackAiRequest({ id: MAIN_WINDOW_ID, once: () => {}, on: () => {} }, "r1", () => {});
  }

  it("asks, and Cancel keeps the app running", async () => {
    await bootApp();
    await startRequest();

    await quit();

    expect(shell.dialogs).toHaveLength(1);
    expect(shell.dialogs[0].buttons).toEqual(["Cancel", "Quit Anyway"]);
    expect(shell.dialogs[0].detail).toContain("its result is lost");
    expect(shell.exits).toEqual([]);
  });

  it("quits on Quit Anyway", async () => {
    await bootApp();
    await startRequest();
    shell.dialogChoice = 1;

    await quit();
    await vi.waitFor(() => expect(shell.exits).toEqual([0]));
  });

  it("quits without asking once the request finished", async () => {
    await bootApp();
    const release = await startRequest();
    release();

    await quit();

    expect(shell.dialogs).toEqual([]);
    expect(shell.exits).toEqual([0]);
  });

  it("never asks at an OS shutdown", async () => {
    await bootApp();
    await startRequest();
    powerHandlers.get("shutdown")!();

    await quit();

    expect(shell.dialogs).toEqual([]);
    expect(shell.exits).toEqual([0]);
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

  it.each(["settled", "blocked", "blocked-dialog-failed"] as const)("routes a renderer load rejection to startup halt with storage %s", async (outcome) => {
    vi.resetModules();
    appHandlers.clear();
    windowHandlers.clear();
    shell.dialogs.length = 0;
    shell.exits.length = 0;
    shell.loggedErrors.length = 0;
    shell.kills.length = 0;
    shell.dialogAnswer = null;
    flush.finishSettles = outcome === "settled";
    shell.dialogFailure = outcome === "blocked-dialog-failed" ? new Error("dialog unavailable") : null;
    shell.windowLoadFailure = new Error("EACCES /private/tmp/renderer.html");

    await import("@main/index.js");
    await vi.waitFor(() => expect(shell.dialogs).toHaveLength(1));

    expect(shell.dialogs[0].detail).toContain("No posts or workspace documents were changed");
    expect(JSON.stringify(shell.dialogs[0])).not.toContain("EACCES");
    expect(JSON.stringify(shell.loggedErrors)).toContain("EACCES");
    if (outcome === "settled") {
      await vi.waitFor(() => expect(shell.exits).toEqual([1]));
      expect(shell.kills).toEqual([]);
    } else {
      await vi.waitFor(() => expect(shell.kills).toEqual(["SIGKILL"]));
      expect(shell.exits).toEqual([]);
    }
    shell.dialogAnswer = null;
    shell.dialogFailure = null;
    flush.finishSettles = true;
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

  it.each(["darwin", "win32", "linux"] as const)("quits on %s when the main window closes, whatever else is open, and only once", async (platform) => {
    onPlatform(platform);
    await bootApp();
    const quits = shell.quitRequests;
    windowHandlers.get("closed")!();
    appHandlers.get("window-all-closed")!();
    expect(shell.quitRequests).toBe(quits + 1);
  });

});
