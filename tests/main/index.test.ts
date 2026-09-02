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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const appHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const windowHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const powerHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const shell = vi.hoisted(() => ({
  exits: [] as number[],
  quitRequests: 0,
  ownsInstance: true,
  windows: [] as { isMinimized: () => boolean; restore: () => void; focus: () => void }[],
  dialogs: [] as { detail?: string }[],
  // What the user clicks in the unsaved-changes dialog: 0 = Cancel (the default).
  dialogChoice: 0,
  windowLoadFailure: null as Error | null,
  loggedErrors: [] as unknown[][],
}));

vi.mock("electron", () => ({
  app: {
    setName: () => {},
    requestSingleInstanceLock: () => shell.ownsInstance,
    getVersion: () => "0.0.0-test",
    whenReady: () => Promise.resolve(),
    on: (event: string, cb: (...args: unknown[]) => unknown) => appHandlers.set(event, cb),
    quit: () => { shell.quitRequests++; },
    exit: (code: number) => shell.exits.push(code),
  },
  BrowserWindow: { getAllWindows: () => shell.windows },
  powerMonitor: {
    on: (event: string, cb: (...args: unknown[]) => unknown) => powerHandlers.set(event, cb),
  },
}));

vi.mock("@main/plain-message-dialog.js", () => ({
  showPlainMessageDialog: async (options: { detail?: string }) => {
    shell.dialogs.push(options);
    return shell.dialogChoice;
  },
}));

vi.mock("@main/window.js", () => ({
  createMainWindow: () => shell.windowLoadFailure ? Promise.reject(shell.windowLoadFailure) : Promise.resolve({
    on: (event: string, cb: (...args: unknown[]) => unknown) => windowHandlers.set(event, cb),
  }),
}));
vi.mock("@main/ipc/index.js", () => ({ registerIpcHandlers: () => {} }));
vi.mock("@main/assetProtocol.js", () => ({
  registerAssetScheme: () => {},
  handleAssetProtocol: () => {},
}));
vi.mock("@main/menu.js", () => ({ installApplicationMenu: () => {} }));
vi.mock("@main/core/services/stateStore.js", () => ({ initStateStore: () => {} }));
vi.mock("@main/core/services/logger.js", () => ({
  initLogger: () => {},
  closeLogger: () => {},
  getCurrentLogFilePath: () => null,
  isDebugLoggingEnabled: () => false,
  redact: (value: unknown) => value,
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: (...args: unknown[]) => { shell.loggedErrors.push(args); },
}));

type PostStore = typeof import("@main/core/services/postStore.js");

let home: string;
let dataDir: string;
const SAVED_HOME = process.env.BIGMOUTH_HOME;

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
  shell.dialogs.length = 0;
  shell.dialogChoice = 0;
  shell.windowLoadFailure = null;
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-quit-"));
  process.env.BIGMOUTH_HOME = home;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-quit-ws-"));
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
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

describe("single app-process ownership", () => {
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

  it("focuses the existing window when another launch is redirected to it", async () => {
    await bootApp();
    const existing = {
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      focus: vi.fn(),
    };
    shell.windows.push(existing);

    appHandlers.get("second-instance")!();

    expect(existing.restore).toHaveBeenCalledOnce();
    expect(existing.focus).toHaveBeenCalledOnce();
  });
});
