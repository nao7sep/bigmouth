import { durabilityUnconfirmed, onDurabilityUnconfirmed } from "../core/shared/publication.js";
import { BrowserWindow, ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import type { UiState } from "@shared/types";
import { getUiState, updateUiState } from "../storageAccess.js";
import { storageOwner } from "../storageOwner.js";
import { info } from "../core/services/logger.js";

export function registerStateHandlers(): void {
  const reportDurability = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send(CHANNELS.durabilityUnconfirmed);
    }
  };
  ipcMain.handle(CHANNELS.getDurabilityUnconfirmed, () => durabilityUnconfirmed() || storageOwner.durabilityUnconfirmed());
  onDurabilityUnconfirmed(reportDurability);
  storageOwner.onDurabilityUnconfirmed(reportDurability);
  ipcMain.handle(CHANNELS.getStoragePending, (_event, workspaceId?: unknown) => {
    if (workspaceId !== undefined && workspaceId !== null && typeof workspaceId !== "string") throw new Error("Invalid workspace identity");
    return storageOwner.storagePendingFor(workspaceId ?? null);
  });
  storageOwner.onStoragePending((pending) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send(CHANNELS.storagePendingChanged, pending);
    }
  });

  ipcMain.handle(CHANNELS.getUiState, async () => await getUiState());

  ipcMain.handle(CHANNELS.updateUiState, async (_event, patch: Partial<UiState>) => {
    const next = await updateUiState(patch);
    // Log which keys changed, not the values, to keep the line stable.
    info("ui state updated", { changed: Object.keys(patch ?? {}) });
    return next;
  });
}
