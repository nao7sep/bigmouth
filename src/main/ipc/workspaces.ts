import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import {
  listWorkspaces,
  getWorkspace,
  openOrCreateWorkspace,
  suggestWorkspaceLocation,
  updateWorkspace,
  deleteWorkspace,
  clearCache,
} from "../storageAccess.js";
import { info, warn, error as logError, serializeError } from "../core/services/logger.js";

export function registerWorkspaceHandlers(): void {
  ipcMain.handle(CHANNELS.listWorkspaces, async () => {
    const workspaces = await listWorkspaces();
    info("workspaces listed", { count: workspaces.length });
    return workspaces;
  });

  ipcMain.handle(CHANNELS.openOrCreateWorkspace, async (_event, name?: string, dataDirectory?: string) => {
    try {
      const ws = await openOrCreateWorkspace(name?.trim(), dataDirectory);
      info("workspace selected", {
        workspaceId: ws.id,
        workspaceName: ws.name,
        dataDirectory: ws.dataDirectory,
      });
      return ws;
    } catch (err) {
      logError("workspace open-or-create failed", { error: serializeError(err) });
      throw err instanceof Error ? err : new Error("Failed to open or create workspace");
    }
  });

  // Read-only: what a blank location would use for this name, so the window can
  // show the real path instead of "default". Nothing is created or logged.
  ipcMain.handle(CHANNELS.suggestWorkspaceLocation, async (_event, name?: unknown) =>
    suggestWorkspaceLocation(typeof name === "string" ? name.trim() : undefined),
  );

  ipcMain.handle(CHANNELS.updateWorkspace, async (_event, id: string, updates: { name?: string }) => {
    const name = updates?.name?.trim();
    if (!name) throw new Error("Workspace name is required");

    let ws;
    try {
      ws = await updateWorkspace(id, { name });
    } catch (err) {
      logError("workspace update failed", { workspaceId: id, error: serializeError(err) });
      throw err instanceof Error ? err : new Error("Failed to update workspace");
    }
    if (!ws) {
      warn("workspace update failed", { workspaceId: id, reason: "not-found" });
      throw new Error("Workspace not found");
    }
    info("workspace updated", {
      workspaceId: ws.id,
      workspaceName: ws.name,
      dataDirectory: ws.dataDirectory,
    });
    return ws;
  });

  ipcMain.handle(CHANNELS.deleteWorkspace, async (_event, id: string) => {
    // Capture the data directory before removal so the derived in-memory index is
    // evicted — re-opening the same folder later must not serve a stale cache.
    const removed = await getWorkspace(id);
    const deleted = await deleteWorkspace(id);
    if (!deleted) {
      warn("workspace delete failed", { workspaceId: id, reason: "not-found" });
      throw new Error("Workspace not found");
    }
    if (removed) await clearCache(removed.dataDirectory);
    info("workspace removed from registry", { workspaceId: id });
  });
}
