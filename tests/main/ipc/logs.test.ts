// Integration test for the renderer log forwarding handler: `electron` (ipcMain)
// and the logger are mocked; everything else runs real.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { CHANNELS } from "@shared/ipc";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
    on: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
  },
}));

const logged = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));

vi.mock("@main/core/services/logger.js", () => ({
  debug: () => {},
  info: () => {},
  warn: logged.warn,
  error: logged.error,
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));

import { registerLogHandlers } from "@main/ipc/logs.js";

function invoke<T>(channel: string, ...args: unknown[]): T {
  return handlers.get(channel)!({}, ...args) as T;
}

beforeEach(() => {
  handlers.clear();
  logged.warn.mockReset();
  logged.error.mockReset();
  registerLogHandlers();
});

// The renderer is sandboxed and opens no log file, so without this channel every
// failure it recovered from left no trace anywhere — a user reporting "it forgot
// my workspace" or "delete didn't warn me about the links" had nothing to give.
describe("renderer log forwarding", () => {
  it("writes a renderer error into the session log, marked as the renderer's", () => {
    invoke(CHANNELS.writeRendererLog, {
      level: "error",
      message: "clipboard write failed",
      detail: { key: "default" },
    });

    expect(logged.error).toHaveBeenCalledWith("clipboard write failed", {
      process: "renderer",
      key: "default",
    });
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it("writes a renderer warning at warn", () => {
    invoke(CHANNELS.writeRendererLog, { level: "warn", message: "something recoverable" });

    expect(logged.warn).toHaveBeenCalledWith("something recoverable", { process: "renderer" });
  });

  it("ignores a malformed entry instead of throwing back at the renderer", () => {
    // Everything crossing this boundary is renderer-supplied, and the channel is
    // one-way: a failure to record something must never become a second failure.
    expect(() => invoke(CHANNELS.writeRendererLog, null)).not.toThrow();
    expect(() => invoke(CHANNELS.writeRendererLog, { level: "error" })).not.toThrow();
    expect(logged.error).not.toHaveBeenCalled();
    expect(logged.warn).not.toHaveBeenCalled();
  });
});
