// Integration test for the directory-picker IPC handler: `electron` (ipcMain,
// BrowserWindow, dialog) and the logger are mocked so the native folder picker is
// controllable; the handler itself runs real. Exercises a chosen path, a
// cancelled dialog, an empty selection, and that the parent window resolved from
// the event is passed through to dialog.showOpenDialog.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNELS } from "@shared/ipc";

const suggestedLocation = vi.hoisted(() => vi.fn());
vi.mock("@main/storageAccess.js", () => ({ suggestWorkspaceLocation: suggestedLocation }));

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

// Controllable native-dialog outcome + the parent window the handler should
// resolve from the event sender.
const dialogState = vi.hoisted(() => ({
  result: { canceled: false, filePaths: [] as string[] },
  window: null as object | null,
}));

const showOpenDialog = vi.hoisted(() => vi.fn());
const fromWebContents = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
    on: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
  },
  BrowserWindow: { fromWebContents },
  dialog: { showOpenDialog },
}));

vi.mock("@main/core/services/logger.js", () => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));

import { registerDialogHandlers } from "@main/ipc/dialog.js";

function invoke<T>(channel: string, event: unknown, purpose: "workspace" | "create" = "workspace", initialDirectory?: string): Promise<T> {
  return handlers.get(channel)!(event, purpose, initialDirectory) as Promise<T>;
}

beforeEach(() => {
  suggestedLocation.mockResolvedValue(path.join(os.tmpdir(), "bigmouth-picker-proposed", "Workspace"));
  handlers.clear();
  showOpenDialog.mockReset();
  fromWebContents.mockReset();
  dialogState.result = { canceled: false, filePaths: [] };
  dialogState.window = null;
  fromWebContents.mockImplementation(() => dialogState.window);
  showOpenDialog.mockImplementation(() => Promise.resolve(dialogState.result));
  registerDialogHandlers();
});

let fixture: string;
beforeEach(() => { fixture = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-picker-")); });
afterEach(() => { fs.rmSync(fixture, { recursive: true, force: true }); });

describe("dialog IPC handler", () => {
  it("returns the chosen directory path when the user picks one", async () => {
    dialogState.result = { canceled: false, filePaths: ["/picked/folder"] };

    const picked = await invoke<string | null>(CHANNELS.pickDirectory, { sender: {} });

    expect(picked).toBe("/picked/folder");
    expect(showOpenDialog).toHaveBeenCalledTimes(1);
  });

  it("returns null when the dialog is cancelled", async () => {
    dialogState.result = { canceled: true, filePaths: [] };

    const picked = await invoke<string | null>(CHANNELS.pickDirectory, { sender: {} });

    expect(picked).toBeNull();
  });

  it("returns null when no path is selected (empty filePaths)", async () => {
    dialogState.result = { canceled: false, filePaths: [] };

    const picked = await invoke<string | null>(CHANNELS.pickDirectory, { sender: {} });

    expect(picked).toBeNull();
  });

  it("passes the resolved parent window through to showOpenDialog", async () => {
    const win = { id: "win" };
    dialogState.window = win;
    dialogState.result = { canceled: false, filePaths: ["/with/window"] };

    const picked = await invoke<string | null>(CHANNELS.pickDirectory, { sender: { fake: true } }, "create");

    expect(picked).toBe("/with/window");
    // With a parent window the modal overload is used: (win, options).
    expect(showOpenDialog).toHaveBeenCalledTimes(1);
    const [firstArg, secondArg] = showOpenDialog.mock.calls[0];
    expect(firstArg).toBe(win);
    expect(secondArg).toMatchObject({ properties: ["openDirectory", "createDirectory"] });
  });

  it("falls back to the window-less overload when no parent window resolves", async () => {
    dialogState.window = null;
    dialogState.result = { canceled: false, filePaths: ["/no/window"] };

    const picked = await invoke<string | null>(CHANNELS.pickDirectory, { sender: {} });

    expect(picked).toBe("/no/window");
    // Without a parent window the single-arg overload is used: (options).
    const [firstArg] = showOpenDialog.mock.calls[0];
    expect(firstArg).toMatchObject({ properties: ["openDirectory"] });
  });

  it("titles the picker by purpose, and offers a new folder only when choosing a destination", async () => {
    dialogState.result = { canceled: false, filePaths: ["/x"] };
    await invoke(CHANNELS.pickDirectory, { sender: {} }, "workspace");
    await invoke(CHANNELS.pickDirectory, { sender: {} }, "create");
    const [[addOptions], [createOptions]] = showOpenDialog.mock.calls as [[Electron.OpenDialogOptions], [Electron.OpenDialogOptions]];
    expect(addOptions.title).toBe("Choose a workspace folder");
    expect(addOptions.properties).toEqual(["openDirectory"]);
    expect(createOptions.title).toBe("Choose where to create the workspace");
    expect(createOptions.properties).toEqual(["openDirectory", "createDirectory"]);
  });
  it("starts creation in the displayed destination and preserves literal characters", async () => {
    const destination = path.join(fixture, " $DRAFTS% ");
    fs.mkdirSync(destination);
    await invoke(CHANNELS.pickDirectory, { sender: {} }, "create", destination);
    expect(showOpenDialog.mock.calls[0][0].defaultPath).toBe(destination);
  });

  it("starts at an existing ancestor without creating the proposed destination", async () => {
    const missing = path.join(fixture, "unavailable", "Workspace");
    await invoke(CHANNELS.pickDirectory, { sender: {} }, "create", missing);
    expect(showOpenDialog.mock.calls[0][0].defaultPath).toBe(fixture);
    expect(fs.existsSync(path.join(fixture, "unavailable"))).toBe(false);
  });

  it("uses the useful first-run default even before the form proposal arrives", async () => {
    const missing = path.join(fixture, "BigMouth", "My Blog");
    suggestedLocation.mockResolvedValue(missing);
    await invoke(CHANNELS.pickDirectory, { sender: {} }, "create");
    expect(showOpenDialog.mock.calls[0][0].defaultPath).toBe(fixture);
    expect(fs.existsSync(path.join(fixture, "BigMouth"))).toBe(false);
  });

  it("uses the active workspace's parent when adding another, without inventing a context", async () => {
    await invoke(CHANNELS.pickDirectory, { sender: {} }, "workspace", path.join(fixture, "Active"));
    expect(showOpenDialog.mock.calls[0][0].defaultPath).toBe(fixture);
    await invoke(CHANNELS.pickDirectory, { sender: {} }, "workspace");
    expect(showOpenDialog.mock.calls[1][0]).not.toHaveProperty("defaultPath");
  });

  it("still permits choosing a destination when its default proposal is unavailable", async () => {
    suggestedLocation.mockRejectedValueOnce(new Error("storage unavailable"));
    dialogState.result = { canceled: false, filePaths: [fixture] };
    expect(await invoke(CHANNELS.pickDirectory, { sender: {} }, "create")).toBe(fixture);
    expect(showOpenDialog.mock.calls[0][0]).not.toHaveProperty("defaultPath");
  });

  it("walks past a file in a proposed path and preserves native picker failures", async () => {
    const file = path.join(fixture, "file");
    fs.writeFileSync(file, "keep");
    showOpenDialog.mockRejectedValueOnce(new Error("native failure"));
    await expect(invoke(CHANNELS.pickDirectory, { sender: {} }, "create", path.join(file, "child")))
      .rejects.toThrow("native failure");
    expect(showOpenDialog.mock.calls[0][0].defaultPath).toBe(fixture);
    expect(fs.readFileSync(file, "utf8")).toBe("keep");
  });

});
