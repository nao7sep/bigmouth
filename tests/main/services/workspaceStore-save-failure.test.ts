import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspace, removeWorkspace, getWorkspace, initAppDir, listWorkspaces, openWorkspace, updateWorkspace } from "@main/core/services/workspaceStore.js";
import { initializeWorkspaceData } from "@main/core/services/dataDir.js";
import { getApiKeysPath, getWorkspacesJsonPath } from "@main/core/services/storagePaths.js";
import { hasStoredApiKey, writeApiKey } from "@main/core/services/apiKeys.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-registry-failure-"));
  vi.stubEnv("BIGMOUTH_DATA_DIR", path.join(root, "storage"));
  initAppDir();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function refuseRegistryPublish() {
  const rename = fs.renameSync;
  return vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
    if (destination === getWorkspacesJsonPath()) throw Object.assign(new Error("registry write refused"), { code: "EACCES" });
    rename(source, destination);
  });
}

describe("workspace registry publication failure", () => {
  it.each(["damaged", "newer", "inaccessible"] as const)("preserves a %s key store and reports incomplete cleanup after removal", (state) => {
    const workspace = createWorkspace("Drafts", path.join(root, "workspace"));
    const keyFile = getApiKeysPath();
    const bytes = state === "newer" ? '{"format":{"owner":"bigmouth","kind":"api-keys","version":99},"opaque":"protected-data"}' : "{ damaged-key-data";
    if (state === "inaccessible") fs.mkdirSync(keyFile);
    else fs.writeFileSync(keyFile, bytes);

    expect(removeWorkspace(workspace.id)).toEqual({ keyCleanupIncomplete: true });
    expect(initAppDir().workspaces).toEqual([]);
    if (state === "inaccessible") expect(fs.statSync(keyFile).isDirectory()).toBe(true);
    else expect(fs.readFileSync(keyFile, "utf8")).toBe(bytes);
    expect(fs.readdirSync(path.dirname(keyFile)).filter((name) => name.endsWith(".invalid"))).toEqual([]);
  });

  it("settles removal after the registry commits when stored key cleanup cannot publish", () => {
    const workspace = createWorkspace("Drafts", path.join(root, "workspace"));
    writeApiKey(getApiKeysPath(), workspace.id, "anthropic", "sk-disposable-key");
    const keyBytes = fs.readFileSync(getApiKeysPath(), "utf8");
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (destination === getApiKeysPath()) throw Object.assign(new Error("key cleanup write refused"), { code: "EACCES" });
      rename(source, destination);
    });

    expect(removeWorkspace(workspace.id)).toEqual({ keyCleanupIncomplete: true });
    expect(getWorkspace(workspace.id)).toBeUndefined();
    expect(initAppDir().workspaces).toEqual([]);
    expect(fs.readFileSync(getApiKeysPath(), "utf8")).toBe(keyBytes);
    expect(hasStoredApiKey(getApiKeysPath(), workspace.id, "anthropic")).toBe(true);
    expect(fs.existsSync(workspace.dataDirectory)).toBe(true);
  });

  it.each(["create", "open"] as const)("does not cache a failed %s and persists its retry", (operation) => {
    const dir = path.join(root, "workspace");
    if (operation === "open") initializeWorkspaceData(dir);
    const before = fs.readFileSync(getWorkspacesJsonPath(), "utf8");
    const refuse = refuseRegistryPublish();
    expect(() => operation === "create" ? createWorkspace("Drafts", dir) : openWorkspace(dir)).toThrow();
    expect(listWorkspaces()).toEqual([]);
    expect(fs.readFileSync(getWorkspacesJsonPath(), "utf8")).toBe(before);
    refuse.mockRestore();
    // Creation may have made the document folders; opening them is the safe retry.
    const workspace = openWorkspace(dir, "Drafts");
    expect(initAppDir().workspaces).toEqual([workspace]);
  });

  it.each(["rename", "remove"] as const)("retains the committed entry after a failed %s", (operation) => {
    const workspace = createWorkspace("Drafts", path.join(root, "workspace"));
    const before = fs.readFileSync(getWorkspacesJsonPath(), "utf8");
    const refuse = refuseRegistryPublish();
    const change = () => operation === "rename" ? updateWorkspace(workspace.id, { name: "New name" }) : removeWorkspace(workspace.id);
    expect(change).toThrow();
    expect(getWorkspace(workspace.id)).toEqual(workspace);
    expect(workspace.name).toBe("Drafts");
    expect(fs.readFileSync(getWorkspacesJsonPath(), "utf8")).toBe(before);
    refuse.mockRestore();
    change();
    expect(initAppDir().workspaces).toEqual(operation === "rename" ? [{ ...workspace, name: "New name" }] : []);
  });
});
