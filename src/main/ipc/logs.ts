import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import {
  revealCurrentLogFile,
  info,
  error as logError,
  serializeError,
} from "../core/services/logger.js";

export function registerLogHandlers(): void {
  // Phase 9 swaps the core's platform-shell reveal for Electron's
  // shell.showItemInFolder; the contract surface stays the same.
  ipcMain.handle(CHANNELS.revealCurrentLogFile, async () => {
    try {
      const path = await revealCurrentLogFile();
      info("current log revealed", { path });
      return path;
    } catch (err) {
      logError("current log reveal failed", { error: serializeError(err) });
      throw err instanceof Error ? err : new Error("Failed to reveal current log file");
    }
  });
}
