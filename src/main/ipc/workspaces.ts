import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import {
  listWorkspaces,
  getWorkspace,
  openOrCreateWorkspace,
  updateWorkspace,
  deleteWorkspace,
} from "../core/services/workspaceStore.js";
import { clearCache } from "../core/services/postStore.js";
import { info, warn, error as logError, serializeError } from "../core/services/logger.js";

export function registerWorkspaceHandlers(): void {
  ipcMain.handle(CHANNELS.listWorkspaces, () => {
    const workspaces = listWorkspaces();
    info("workspaces listed", { count: workspaces.length });
    return workspaces;
  });

  ipcMain.handle(CHANNELS.openOrCreateWorkspace, (_event, name?: string, dataDirectory?: string) => {
    try {
      const ws = openOrCreateWorkspace(name?.trim(), dataDirectory?.trim());
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

  ipcMain.handle(CHANNELS.updateWorkspace, (_event, id: string, updates: { name?: string; dataDirectory?: string }) => {
    let ws;
    try {
      ws = updateWorkspace(id, {
        name: updates.name?.trim(),
        dataDirectory: updates.dataDirectory?.trim(),
      });
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

  ipcMain.handle(CHANNELS.deleteWorkspace, (_event, id: string) => {
    // Capture the data directory before removal so the derived in-memory index is
    // evicted — re-opening the same folder later must not serve a stale cache.
    const removed = getWorkspace(id);
    const deleted = deleteWorkspace(id);
    if (!deleted) {
      warn("workspace delete failed", { workspaceId: id, reason: "not-found" });
      throw new Error("Workspace not found");
    }
    if (removed) clearCache(removed.dataDirectory);
    info("workspace removed from registry", { workspaceId: id });
  });
}
