// Integration test for the workspace IPC handlers: the real workspaceStore runs
// against a throwaway BIGMOUTH_HOME; only `electron` (ipcMain) and the logger are
// mocked. Exercises list/openOrCreate/update/delete, argument trimming, the
// not-found -> thrown-Error mapping, and the rule that deleting a workspace also
// drops its stored API keys (asserted through the apiKeys service, mirroring
// tests/main/services/workspaceStore.test.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNELS } from "@shared/ipc";
import type { Workspace } from "@shared/types";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
    on: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
  },
}));

vi.mock("@main/core/services/logger.js", () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));

import { initAppDir, getApiKeysPath, listWorkspaces } from "@main/core/services/workspaceStore.js";
import { writeApiKey, readStoredConfigIds } from "@main/core/services/apiKeys.js";
import { registerWorkspaceHandlers } from "@main/ipc/workspaces.js";

let home: string;
const tempDirs: string[] = [];
const SAVED_HOME = process.env.BIGMOUTH_HOME;

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bigmouth-ipc-ws-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function invoke<T>(channel: string, ...args: unknown[]): T {
  return handlers.get(channel)!({}, ...args) as T;
}

beforeEach(() => {
  home = tempDir("home");
  process.env.BIGMOUTH_HOME = home;
  initAppDir();
  handlers.clear();
  registerWorkspaceHandlers();
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("workspace IPC handlers", () => {
  it("lists no workspaces on a fresh storage root", () => {
    expect(invoke<Workspace[]>(CHANNELS.listWorkspaces)).toEqual([]);
  });

  it("creates a workspace (default location) and then lists it", () => {
    const ws = invoke<Workspace>(CHANNELS.openOrCreateWorkspace, "My WS");
    expect(ws.name).toBe("My WS");
    expect(ws.id).toBeTruthy();
    expect(fs.existsSync(path.join(ws.dataDirectory, "settings.json"))).toBe(true);

    const list = invoke<Workspace[]>(CHANNELS.listWorkspaces);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(ws.id);
  });

  it("trims the name when opening-or-creating, then opens the same directory idempotently", () => {
    const dir = tempDir("explicit");
    const ws = invoke<Workspace>(CHANNELS.openOrCreateWorkspace, "  Spaced  ", `  ${dir}  `);
    expect(ws.name).toBe("Spaced");
    expect(ws.dataDirectory).toBe(dir);

    // Re-opening the same directory returns the existing entry, not a duplicate.
    const again = invoke<Workspace>(CHANNELS.openOrCreateWorkspace, "ignored", dir);
    expect(again.id).toBe(ws.id);
    expect(listWorkspaces()).toHaveLength(1);
  });

  it("maps a store rejection (non-empty, non-workspace folder) to a thrown Error", () => {
    const dir = tempDir("nonempty");
    fs.writeFileSync(path.join(dir, "stray.txt"), "not a workspace");
    expect(() => invoke(CHANNELS.openOrCreateWorkspace, "WS", dir)).toThrow(/empty/i);
    expect(listWorkspaces()).toHaveLength(0);
  });

  it("updates a workspace name and trims it", () => {
    const ws = invoke<Workspace>(CHANNELS.openOrCreateWorkspace, "Before");
    const updated = invoke<Workspace>(CHANNELS.updateWorkspace, ws.id, { name: "  After  " });
    expect(updated.name).toBe("After");
    expect(listWorkspaces()[0].name).toBe("After");
  });

  it("throws 'Workspace not found' when updating an unknown id", () => {
    expect(() => invoke(CHANNELS.updateWorkspace, "nope", { name: "x" })).toThrow(/not found/i);
  });

  it("maps a rejected directory update (non-empty folder) to a thrown Error without mutating", () => {
    const ws = invoke<Workspace>(CHANNELS.openOrCreateWorkspace, "Original");
    const badDir = tempDir("bad");
    fs.writeFileSync(path.join(badDir, "junk.txt"), "x");
    expect(() => invoke(CHANNELS.updateWorkspace, ws.id, { name: "Renamed", dataDirectory: badDir })).toThrow();
    // The rejected update must not have applied the name change.
    expect(listWorkspaces()[0].name).toBe("Original");
  });

  it("deletes a workspace and clears its stored API keys", () => {
    const ws = invoke<Workspace>(CHANNELS.openOrCreateWorkspace, "Keyed");
    writeApiKey(getApiKeysPath(), ws.id, "c1", "sk-secret");
    expect(readStoredConfigIds(getApiKeysPath(), ws.id).has("c1")).toBe(true);

    const result = invoke<void>(CHANNELS.deleteWorkspace, ws.id);
    expect(result).toBeUndefined();
    expect(listWorkspaces()).toHaveLength(0);
    // The shared secrets file is keyed by workspace id; deletion must take the
    // keys with it rather than orphan them.
    expect(readStoredConfigIds(getApiKeysPath(), ws.id).has("c1")).toBe(false);
  });

  it("throws 'Workspace not found' when deleting an unknown id", () => {
    expect(() => invoke(CHANNELS.deleteWorkspace, "nope")).toThrow(/not found/i);
  });
});
