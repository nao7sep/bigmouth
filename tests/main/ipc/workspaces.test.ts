// Integration test for the workspace IPC handlers: the real workspaceStore runs
// against a throwaway BIGMOUTH_DATA_DIR; the async storageAccess edge calls these real services while Electron and the logger
// are mocked. Exercises list/create/add-existing/update/delete, name cleanup, literal paths, the
// not-found -> thrown-Error mapping, and the rule that deleting a workspace also
// drops its stored API keys (asserted through the apiKeys service, mirroring
// tests/main/services/workspaceStore.test.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNELS } from "@shared/ipc";
import type { Workspace, WorkspaceDeleteResult } from "@shared/types";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("@main/storageAccess.js", async () => {
  const workspaceStore = await import("@main/core/services/workspaceStore.js");
  const postStore = await import("@main/core/services/postStore.js");
  const { storageTasks } = await import("@main/storageTasks.js");
  return {
    listWorkspaces: async (...args: Parameters<typeof workspaceStore.listWorkspaces>) => workspaceStore.listWorkspaces(...args),
    getWorkspace: async (...args: Parameters<typeof workspaceStore.getWorkspace>) => workspaceStore.getWorkspace(...args),
    createWorkspace: async (...args: Parameters<typeof storageTasks.createWorkspace>) => storageTasks.createWorkspace(...args),
    addExistingWorkspace: async (...args: Parameters<typeof storageTasks.addExistingWorkspace>) => storageTasks.addExistingWorkspace(...args),
    suggestWorkspaceLocation: async (...args: Parameters<typeof workspaceStore.suggestWorkspaceLocation>) => workspaceStore.suggestWorkspaceLocation(...args),
    updateWorkspace: async (...args: Parameters<typeof workspaceStore.updateWorkspace>) => workspaceStore.updateWorkspace(...args),
    deleteWorkspace: async (...args: Parameters<typeof storageTasks.deleteWorkspace>) => storageTasks.deleteWorkspace(...args),
    clearCache: async (...args: Parameters<typeof postStore.clearCache>) => postStore.clearCache(...args),
  };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
    on: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
  },
}));

vi.mock("@main/core/services/logger.js", () => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));

import { initAppDir, listWorkspaces } from "@main/core/services/workspaceStore.js";
import { getApiKeysPath } from "@main/core/services/storagePaths.js";
import { writeApiKey, hasStoredApiKey } from "@main/core/services/apiKeys.js";
import { registerWorkspaceHandlers } from "@main/ipc/workspaces.js";

let home: string;
const tempDirs: string[] = [];
const SAVED_HOME = process.env.BIGMOUTH_DATA_DIR;

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bigmouth-ipc-ws-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return handlers.get(channel)!({}, ...args) as Promise<T>;
}

beforeEach(() => {
  home = tempDir("home");
  process.env.BIGMOUTH_DATA_DIR = home;
  initAppDir();
  handlers.clear();
  registerWorkspaceHandlers();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("workspace IPC handlers", () => {
  it("lists no workspaces on a fresh storage root", async () => {
    expect((await invoke<Workspace[]>(CHANNELS.listWorkspaces))).toEqual([]);
  });

  it("creates a workspace (default location) and then lists it", async () => {
    const ws = (await invoke<Workspace>(CHANNELS.createWorkspace, "My WS"));
    expect(ws.name).toBe("My WS");
    expect(ws.id).toBeTruthy();
    expect(ws.dataDirectory).toBe(path.join(os.homedir(), "Documents", "BigMouth", "My WS"));
    expect(fs.existsSync(path.join(ws.dataDirectory, "config.json"))).toBe(false);

    const list = (await invoke<Workspace[]>(CHANNELS.listWorkspaces));
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(ws.id);
  });

  it("suggests the folder creation would use, trimming the name and creating nothing", async () => {
    const parent = path.join(os.homedir(), "Documents", "BigMouth");
    expect(await invoke<string>(CHANNELS.suggestWorkspaceLocation, "  Blog  ")).toBe(path.join(parent, "Blog"));
    // A blank or non-text name asks for the default name's folder.
    expect(await invoke<string>(CHANNELS.suggestWorkspaceLocation, "")).toBe(path.join(parent, "Workspace"));
    expect(await invoke<string>(CHANNELS.suggestWorkspaceLocation, 42)).toBe(path.join(parent, "Workspace"));
    expect(fs.existsSync(parent)).toBe(false);
    expect(listWorkspaces()).toHaveLength(0);

    const ws = await invoke<Workspace>(CHANNELS.createWorkspace, "Blog");
    expect(ws.dataDirectory).toBe(path.join(parent, "Blog"));
    expect(await invoke<string>(CHANNELS.suggestWorkspaceLocation, "Blog")).toBe(path.join(parent, "Blog (2)"));
  });

  it("creates inside a chosen parent, in a folder named after the workspace", async () => {
    const parent = tempDir("parent");
    expect(await invoke<string>(CHANNELS.suggestWorkspaceLocation, "Notes", parent)).toBe(path.join(parent, "Notes"));
    const ws = await invoke<Workspace>(CHANNELS.createWorkspace, "  Notes  ", parent);
    expect(ws.name).toBe("Notes");
    expect(ws.dataDirectory).toBe(path.join(parent, "Notes"));
    expect(fs.existsSync(path.join(os.homedir(), "Documents", "BigMouth"))).toBe(false);
  });

  it("refuses to create a workspace without a name", async () => {
    await expect(invoke(CHANNELS.createWorkspace, "   ")).rejects.toThrow(/name is required/i);
    await expect(invoke(CHANNELS.createWorkspace, undefined)).rejects.toThrow(/name is required/i);
    expect(listWorkspaces()).toHaveLength(0);
  });

  it("adds an existing workspace folder once, named after the folder", async () => {
    const ws = await invoke<Workspace>(CHANNELS.createWorkspace, "Shared", tempDir("shared"));
    await invoke(CHANNELS.deleteWorkspace, ws.id);

    const added = await invoke<Workspace>(CHANNELS.addExistingWorkspace, ws.dataDirectory);
    expect(added.name).toBe("Shared");
    expect(added.dataDirectory).toBe(ws.dataDirectory);
    // Adding a listed folder again returns its entry, not a duplicate.
    expect((await invoke<Workspace>(CHANNELS.addExistingWorkspace, ws.dataDirectory)).id).toBe(added.id);
    expect(listWorkspaces()).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("preserves a native-picked parent with leading and trailing spaces", async () => {
    const root = tempDir("literal-spaces");
    const parent = path.join(root, " Parent ");
    fs.mkdirSync(parent);

    const ws = (await invoke<Workspace>(CHANNELS.createWorkspace, "Literal", parent));

    expect(ws.dataDirectory).toBe(path.join(parent, "Literal"));
    expect(fs.existsSync(path.join(root, "Parent"))).toBe(false);
  });

  it("refuses to add a folder that holds no workspace, saying so in the user's words", async () => {
    const dir = tempDir("foreign-config");
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ title: "My Blog" }));
    await expect(invoke(CHANNELS.addExistingWorkspace, dir)).rejects.toThrow(/workspaces\.notAWorkspace/);
    await expect(invoke(CHANNELS.addExistingWorkspace, tempDir("empty"))).rejects.toThrow(/workspaces\.notAWorkspace/);
    expect(listWorkspaces()).toHaveLength(0);
  });

  it("updates a workspace name and trims it", async () => {
    const ws = (await invoke<Workspace>(CHANNELS.createWorkspace, "Before"));
    const updated = (await invoke<Workspace>(CHANNELS.updateWorkspace, ws.id, { name: "  After  " }));
    expect(updated.name).toBe("After");
    expect(listWorkspaces()[0].name).toBe("After");
  });

  it("throws 'Workspace not found' when updating an unknown id", async () => {
    await expect(invoke(CHANNELS.updateWorkspace, "nope", { name: "x" })).rejects.toThrow(/not found/i);
  });

  it("refuses a rename with no name, rather than clearing it", async () => {
    const ws = (await invoke<Workspace>(CHANNELS.createWorkspace, "Original"));

    await expect(invoke(CHANNELS.updateWorkspace, ws.id, { name: "   " })).rejects.toThrow(/name is required/i);
    await expect(invoke(CHANNELS.updateWorkspace, ws.id, {})).rejects.toThrow(/name is required/i);
    expect(listWorkspaces()[0].name).toBe("Original");
  });

  it("deletes a workspace and clears its stored API keys", async () => {
    const ws = (await invoke<Workspace>(CHANNELS.createWorkspace, "Keyed"));
    writeApiKey(getApiKeysPath(), ws.id, "anthropic", "sk-secret");
    expect(hasStoredApiKey(getApiKeysPath(), ws.id, "anthropic")).toBe(true);

    const result = (await invoke<WorkspaceDeleteResult>(CHANNELS.deleteWorkspace, ws.id));
    expect(result).toEqual({});
    expect(listWorkspaces()).toHaveLength(0);
    // The shared secrets file is keyed by workspace id; deletion must take the
    // keys with it rather than orphan them.
    expect(hasStoredApiKey(getApiKeysPath(), ws.id, "anthropic")).toBe(false);
  });

  it("throws 'Workspace not found' when deleting an unknown id", async () => {
    await expect(invoke(CHANNELS.deleteWorkspace, "nope")).rejects.toThrow(/not found/i);
  });

  it("returns the committed removal with a warning when stored key cleanup fails", async () => {
    const ws = await invoke<Workspace>(CHANNELS.createWorkspace, "Keyed");
    writeApiKey(getApiKeysPath(), ws.id, "anthropic", "sk-disposable-key");
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (destination === getApiKeysPath()) throw Object.assign(new Error("key cleanup write refused"), { code: "EACCES" });
      rename(source, destination);
    });

    await expect(invoke<WorkspaceDeleteResult>(CHANNELS.deleteWorkspace, ws.id)).resolves.toEqual({ keyCleanupIncomplete: true });
    expect(await invoke<Workspace[]>(CHANNELS.listWorkspaces)).toEqual([]);
    expect(hasStoredApiKey(getApiKeysPath(), ws.id, "anthropic")).toBe(true);
  });
});
