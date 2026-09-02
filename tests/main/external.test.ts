import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const openExternal = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
  shell: { openExternal },
}));

vi.mock("@main/core/services/logger.js", () => ({ info: vi.fn() }));

import { CHANNELS } from "@shared/ipc";
import { isAllowedExternalUrl, registerExternalHandlers } from "@main/ipc/external.js";

beforeEach(() => {
  handlers.clear();
  openExternal.mockReset();
  registerExternalHandlers();
});

describe("external URL IPC", () => {
  it("awaits the OS handler so its rejection reaches the renderer", async () => {
    const hostile = new Error("EACCES /private/tmp/browser-handler");
    openExternal.mockRejectedValueOnce(hostile);

    await expect(handlers.get(CHANNELS.openExternal)!({}, "https://example.com"))
      .rejects.toBe(hostile);
  });

  it("rejects local and executable schemes before reaching the OS", async () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "not a url"]) {
      expect(isAllowedExternalUrl(url)).toBe(false);
      await expect(handlers.get(CHANNELS.openExternal)!({}, url)).rejects.toThrow("not allowed");
    }
    expect(openExternal).not.toHaveBeenCalled();
  });
});
