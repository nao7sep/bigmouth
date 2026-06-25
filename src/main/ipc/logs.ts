import { ipcMain, shell } from "electron";

import { CHANNELS } from "@shared/ipc";
import { getCurrentLogFilePath, info, warn } from "../core/services/logger.js";

export function registerLogHandlers(): void {
  ipcMain.handle(CHANNELS.revealCurrentLogFile, () => {
    const path = getCurrentLogFilePath();
    if (!path) {
      warn("current log reveal failed", { reason: "no-current-log" });
      throw new Error("Current log file is not available");
    }
    shell.showItemInFolder(path);
    info("current log revealed", { path });
    return path;
  });
}
