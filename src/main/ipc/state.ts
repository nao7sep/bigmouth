import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import type { UiState } from "@shared/types";
import { getUiState, updateUiState } from "../storageAccess.js";
import { info } from "../core/services/logger.js";

export function registerStateHandlers(): void {
  ipcMain.handle(CHANNELS.getUiState, async () => await getUiState());

  ipcMain.handle(CHANNELS.updateUiState, async (_event, patch: Partial<UiState>) => {
    const next = await updateUiState(patch);
    // Log which keys changed, not the values, to keep the line stable.
    info("ui state updated", { changed: Object.keys(patch ?? {}) });
    return next;
  });
}
