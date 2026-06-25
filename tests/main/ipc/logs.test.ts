// Integration test for the log IPC handler: `electron` (ipcMain + shell) and the
// logger are mocked so the current-log path is controllable; everything else runs
// real. Exercises the happy path (reveals the file and returns its path), the
// no-current-log validation, and that the reveal is delegated to the shell.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { CHANNELS } from "@shared/ipc";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const shellMock = vi.hoisted(() => ({ showItemInFolder: vi.fn() }));
const loggerState = vi.hoisted(() => ({ currentLogFilePath: null as string | null }));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
    on: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
  },
  shell: shellMock,
}));

vi.mock("@main/core/services/logger.js", () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
  getCurrentLogFilePath: () => loggerState.currentLogFilePath,
}));

import { registerLogHandlers } from "@main/ipc/logs.js";

function invoke<T>(channel: string, ...args: unknown[]): T {
  return handlers.get(channel)!({}, ...args) as T;
}

beforeEach(() => {
  handlers.clear();
  shellMock.showItemInFolder.mockReset();
  loggerState.currentLogFilePath = null;
  registerLogHandlers();
});

describe("log IPC handler", () => {
  it("reveals the current log file and returns its path", () => {
    loggerState.currentLogFilePath = "/logs/session.log";

    const returned = invoke<string>(CHANNELS.revealCurrentLogFile);

    expect(returned).toBe("/logs/session.log");
    expect(shellMock.showItemInFolder).toHaveBeenCalledTimes(1);
    expect(shellMock.showItemInFolder).toHaveBeenCalledWith("/logs/session.log");
  });

  it("throws when there is no current log file, without touching the shell", () => {
    loggerState.currentLogFilePath = null;

    expect(() => invoke(CHANNELS.revealCurrentLogFile)).toThrow(/not available/i);
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });
});
