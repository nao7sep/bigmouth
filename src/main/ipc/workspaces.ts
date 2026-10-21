import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import {
  listWorkspaces,
  createWorkspace,
  addExistingWorkspace,
  suggestWorkspaceLocation,
  updateWorkspace,
  deleteWorkspace,
} from "../storageAccess.js";
import { info, warn, error as logError, serializeError } from "../core/services/logger.js";
import { imageDerivatives } from "../imageDerivatives.js";

export function registerWorkspaceHandlers(): void {
  ipcMain.handle(CHANNELS.listWorkspaces, async () => {
    const workspaces = await listWorkspaces();
    info("workspaces listed", { count: workspaces.length });
    return workspaces;
  });

  ipcMain.handle(CHANNELS.createWorkspace, async (_event, name: unknown, dataDirectory?: unknown) => {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) throw new Error("Workspace name is required");
    try {
      const ws = await createWorkspace(trimmed, typeof dataDirectory === "string" && dataDirectory ? dataDirectory : undefined);
      info("workspace created", { workspaceId: ws.id, workspaceName: ws.name, dataDirectory: ws.dataDirectory });
      return ws;
    } catch (err) {
      logError("workspace creation failed", { error: serializeError(err) });
      throw err instanceof Error ? err : new Error("Failed to create workspace");
    }
  });

  ipcMain.handle(CHANNELS.addExistingWorkspace, async (_event, dataDirectory: unknown) => {
    if (typeof dataDirectory !== "string" || !dataDirectory) throw new Error("A workspace folder is required");
    try {
      const ws = await addExistingWorkspace(dataDirectory);
      info("workspace added", { workspaceId: ws.id, workspaceName: ws.name, dataDirectory: ws.dataDirectory });
      return ws;
    } catch (err) {
      logError("workspace add failed", { dataDirectory, error: serializeError(err) });
      throw err instanceof Error ? err : new Error("Failed to add workspace");
    }
  });

  // A read-only default proposal; selected destinations bypass suggestion.
  ipcMain.handle(CHANNELS.suggestWorkspaceLocation, async () =>
    suggestWorkspaceLocation(),
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
    const deleted = await deleteWorkspace(id);
    if (deleted === null) {
      warn("workspace delete failed", { workspaceId: id, reason: "not-found" });
      throw new Error("Workspace not found");
    }
    info("workspace removed from registry", { workspaceId: id });
    imageDerivatives()?.forgetWorkspace(id);
    return deleted;
  });
}
