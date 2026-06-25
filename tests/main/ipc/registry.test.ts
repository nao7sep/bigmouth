// Smoke test for the IPC registrar aggregator: registering once must wire a
// handler for every channel in CHANNELS, proving each domain registrar ran and
// no channel is left without a main-process handler.

import { describe, it, expect, vi } from "vitest";
import { CHANNELS } from "@shared/ipc";

const registered = vi.hoisted(() => new Set<string>());

vi.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string) => registered.add(ch),
    on: (ch: string) => registered.add(ch),
  },
  // Stubs for the electron surfaces some handlers import (used only inside their
  // callbacks, never at registration) — present so module load never fails.
  app: {},
  shell: {},
  dialog: {},
  BrowserWindow: {},
}));

import { registerIpcHandlers } from "@main/ipc/index.js";

describe("registerIpcHandlers", () => {
  it("registers a handler for every IPC channel", () => {
    registerIpcHandlers();
    for (const channel of Object.values(CHANNELS)) {
      expect(registered.has(channel), `no handler registered for ${channel}`).toBe(true);
    }
  });
});
