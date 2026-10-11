import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspace, deleteWorkspace, getWorkspace, initAppDir, listWorkspaces, openWorkspace, updateWorkspace } from "@main/core/services/workspaceStore.js";
import { initializeWorkspaceData } from "@main/core/services/dataDir.js";
import { getWorkspacesJsonPath } from "@main/core/services/storagePaths.js";

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
    const change = () => operation === "rename" ? updateWorkspace(workspace.id, { name: "New name" }) : deleteWorkspace(workspace.id);
    expect(change).toThrow();
    expect(getWorkspace(workspace.id)).toEqual(workspace);
    expect(workspace.name).toBe("Drafts");
    expect(fs.readFileSync(getWorkspacesJsonPath(), "utf8")).toBe(before);
    refuse.mockRestore();
    change();
    expect(initAppDir().workspaces).toEqual(operation === "rename" ? [{ ...workspace, name: "New name" }] : []);
  });
});
