// Integration test for the directory-picker IPC handler: `electron` (ipcMain,
// BrowserWindow, dialog) and the logger are mocked so the native folder picker is
// controllable; the handler itself runs real. Exercises a chosen path, a
// cancelled dialog, an empty selection, and that the parent window resolved from
// the event is passed through to dialog.showOpenDialog.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { CHANNELS } from "@shared/ipc";

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
  info: () => {},
  warn: () => {},
  error: () => {},
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));

import { registerDialogHandlers } from "@main/ipc/dialog.js";

function invoke<T>(channel: string, event: unknown): Promise<T> {
  return handlers.get(channel)!(event) as Promise<T>;
}

beforeEach(() => {
  handlers.clear();
  showOpenDialog.mockReset();
  fromWebContents.mockReset();
  dialogState.result = { canceled: false, filePaths: [] };
  dialogState.window = null;
  fromWebContents.mockImplementation(() => dialogState.window);
  showOpenDialog.mockImplementation(() => Promise.resolve(dialogState.result));
  registerDialogHandlers();
});

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

    const picked = await invoke<string | null>(CHANNELS.pickDirectory, { sender: { fake: true } });

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
    expect(firstArg).toMatchObject({ properties: ["openDirectory", "createDirectory"] });
  });
});
