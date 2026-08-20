// The workspace registry is the gate for where workspace data lands. These
// tests cover the create/open/reject decisions and the rule that a rejected
// updateWorkspace leaves the in-memory registry untouched (no partial mutation).
// Path expansion / cwd-independence is covered separately in storagePaths.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initAppDir, createWorkspace, openWorkspace, openOrCreateWorkspace, updateWorkspace, deleteWorkspace, getWorkspace, listWorkspaces } from "@main/core/services/workspaceStore.js";
import { getApiKeysPath } from "@main/core/services/storagePaths.js";
import { initializeWorkspaceData } from "@main/core/services/dataDir.js";
import { writeApiKey, readStoredConfigIds } from "@main/core/services/apiKeys.js";

const SAVED_HOME = process.env.BIGMOUTH_HOME;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bigmouth-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  // A fresh storage root per test gives a clean, empty registry.
  process.env.BIGMOUTH_HOME = tempDir("wsroot");
  initAppDir();
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// One folder must never register as two workspaces. Two registrations mean two
// ids, two in-memory indexes keyed by different strings writing over a single
// posts/index.json, and two separate API-key sets for one folder.
describe("workspace identity", () => {
  it("rejects the same folder reached with a trailing separator", () => {
    const dir = tempDir("dupe");
    createWorkspace("A", dir);

    expect(() => createWorkspace("B", `${dir}${path.sep}`)).toThrow(/already registered as workspace "A"/);
    expect(listWorkspaces()).toHaveLength(1);
  });

  it("rejects the same folder reached with different case on a case-insensitive volume", () => {
    const parent = tempDir("case");
    const dir = path.join(parent, "MyWorkspace");
    fs.mkdirSync(dir);
    createWorkspace("A", dir);

    // Only meaningful where the volume actually folds case; on a case-sensitive
    // one these are genuinely two folders and registering both would be correct.
    const variant = path.join(parent, "myworkspace");
    if (!fs.existsSync(variant)) return;

    expect(() => createWorkspace("B", variant)).toThrow(/already registered as workspace "A"/);
    expect(listWorkspaces()).toHaveLength(1);
  });

  it("rejects the same folder named in a different Unicode form", () => {
    // macOS hands back NFD from a file dialog where the user typed NFC.
    const parent = tempDir("nfc");
    const nfc = path.join(parent, "caf\u00e9");
    fs.mkdirSync(nfc);
    createWorkspace("A", nfc);

    const nfd = path.join(parent, "cafe\u0301");
    expect(() => createWorkspace("B", nfd)).toThrow(/already registered as workspace "A"/);
    expect(listWorkspaces()).toHaveLength(1);
  });

  it("rejects the same folder reached through a symlink", () => {
    const parent = tempDir("link");
    const real = path.join(parent, "real");
    fs.mkdirSync(real);
    createWorkspace("A", real);

    const link = path.join(parent, "link");
    fs.symlinkSync(real, link, "dir");
    expect(() => createWorkspace("B", link)).toThrow(/already registered as workspace "A"/);
    expect(listWorkspaces()).toHaveLength(1);
  });

  it("still registers two genuinely different folders", () => {
    createWorkspace("A", tempDir("one"));
    createWorkspace("B", tempDir("two"));
    expect(listWorkspaces()).toHaveLength(2);
  });
});

describe("createWorkspace gating", () => {
  it("rejects a non-empty folder that is not a workspace", () => {
    const dir = tempDir("nonempty");
    fs.writeFileSync(path.join(dir, "stray.txt"), "not a workspace");
    expect(() => createWorkspace("WS", dir)).toThrow(/empty folder/);
    expect(listWorkspaces()).toHaveLength(0);
  });

  it("rejects a folder that already contains a workspace (directing to Open)", () => {
    const dir = tempDir("existing-ws");
    initializeWorkspaceData(dir); // a complete workspace on disk, not yet registered
    expect(() => createWorkspace("WS", dir)).toThrow(/already contains a workspace/);
  });

  it("rejects registering the same directory twice", () => {
    const dir = tempDir("dup");
    const ws = createWorkspace("First", dir);
    expect(() => createWorkspace("Second", dir)).toThrow(/already registered/);
    // Opening the same directory returns the existing entry rather than duplicating.
    expect(openWorkspace(dir).id).toBe(ws.id);
    expect(listWorkspaces()).toHaveLength(1);
  });
});

describe("openWorkspace gating", () => {
  it("rejects a directory missing a required workspace file", () => {
    const dir = tempDir("partial");
    initializeWorkspaceData(dir);
    fs.unlinkSync(path.join(dir, "config.json")); // a partial workspace is broken, not openable
    expect(() => openWorkspace(dir)).toThrow(/workspace folder/);
  });

  it("rejects a generic folder whose config.json is not a BigMouth config", () => {
    // A blog or static-site folder can hold config.json + posts/ + assets/ without
    // being a workspace; accepting it would overwrite its config on the first save.
    const dir = tempDir("blog");
    fs.mkdirSync(path.join(dir, "posts"));
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ title: "My Blog", theme: "dark" }));
    expect(() => openWorkspace(dir)).toThrow(/workspace folder/);
  });
});

describe("updateWorkspace validates before mutating", () => {
  it("leaves the name unchanged when the directory change is rejected", () => {
    const wsDir = tempDir("ws");
    const ws = createWorkspace("Original", wsDir);

    const badDir = tempDir("bad");
    fs.writeFileSync(path.join(badDir, "junk.txt"), "x"); // non-empty, not a workspace

    expect(() =>
      updateWorkspace(ws.id, { name: "Renamed", dataDirectory: badDir }),
    ).toThrow();

    // The rejected update must not have applied the name change in memory — the
    // same objects listWorkspaces hands the renderer — or moved the directory.
    expect(getWorkspace(ws.id)?.name).toBe("Original");
    expect(getWorkspace(ws.id)?.dataDirectory).toBe(wsDir);
  });

  it("applies a valid name-only change", () => {
    const ws = createWorkspace("Before", tempDir("ws"));
    const updated = updateWorkspace(ws.id, { name: "After" });
    expect(updated?.name).toBe("After");
    expect(getWorkspace(ws.id)?.name).toBe("After");
  });
});

describe("openOrCreateWorkspace", () => {
  it("creates a default-named workspace when no directory is given", () => {
    const ws = openOrCreateWorkspace();
    expect(ws.name).toBe("Workspace");
    expect(listWorkspaces()).toHaveLength(1);
    // A second nameless create resolves the next free default name.
    expect(openOrCreateWorkspace().name).toBe("Workspace 2");
  });

  it("opens an existing workspace directory instead of recreating it", () => {
    const dir = tempDir("existing");
    initializeWorkspaceData(dir); // a complete workspace on disk, not yet registered
    const ws = openOrCreateWorkspace("Reopened", dir);
    expect(ws.dataDirectory).toBe(dir);
    expect(listWorkspaces()).toHaveLength(1);
    // Calling again returns the same registered entry, not a duplicate.
    expect(openOrCreateWorkspace(undefined, dir).id).toBe(ws.id);
    expect(listWorkspaces()).toHaveLength(1);
  });

  it("creates a workspace in an empty directory", () => {
    const dir = tempDir("empty");
    const ws = openOrCreateWorkspace("Fresh", dir);
    expect(ws.name).toBe("Fresh");
    expect(ws.dataDirectory).toBe(dir);
  });

  it("rejects a non-empty directory that is not a workspace", () => {
    const dir = tempDir("nonempty");
    fs.writeFileSync(path.join(dir, "junk.txt"), "x");
    expect(() => openOrCreateWorkspace("X", dir)).toThrow(/empty or already contain/i);
  });

  it("rejects a path that exists but is a file", () => {
    const dir = tempDir("hostdir");
    const filePath = path.join(dir, "afile");
    fs.writeFileSync(filePath, "x");
    expect(() => openOrCreateWorkspace("X", filePath)).toThrow(/must be a directory/i);
  });
});

describe("updateWorkspace directory change", () => {
  it("applies a valid directory change to an empty folder", () => {
    const ws = createWorkspace("WS", tempDir("ws"));
    const newDir = tempDir("moved");
    const updated = updateWorkspace(ws.id, { dataDirectory: newDir });
    expect(updated?.dataDirectory).toBe(newDir);
    expect(getWorkspace(ws.id)?.dataDirectory).toBe(newDir);
  });

  it("rejects a directory already registered to another workspace", () => {
    const a = createWorkspace("A", tempDir("a"));
    const bDir = tempDir("b");
    createWorkspace("B", bDir);
    expect(() => updateWorkspace(a.id, { dataDirectory: bDir })).toThrow(/already registered/i);
  });

  it("returns null when updating an unknown workspace", () => {
    expect(updateWorkspace("nope", { name: "x" })).toBeNull();
  });
});

describe("deleteWorkspace", () => {
  it("removes the workspace and clears its stored API keys", () => {
    const ws = createWorkspace("Keyed", tempDir("ws"));
    writeApiKey(getApiKeysPath(), ws.id, "c1", "anthropic", "sk-secret");
    expect(readStoredConfigIds(getApiKeysPath(), ws.id).has("c1")).toBe(true);

    expect(deleteWorkspace(ws.id)).toBe(true);
    expect(getWorkspace(ws.id)).toBeUndefined();
    // The shared secrets file is keyed by workspace id; deletion must take its
    // keys with it rather than orphan them.
    expect(readStoredConfigIds(getApiKeysPath(), ws.id).has("c1")).toBe(false);
  });

  it("returns false for an unknown workspace id", () => {
    expect(deleteWorkspace("nope")).toBe(false);
  });
});
