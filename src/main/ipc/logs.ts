import { ipcMain, shell } from "electron";

import { CHANNELS, type RendererLogEntry } from "@shared/ipc";
import { getCurrentLogFilePath, error as logError, info, warn } from "../core/services/logger.js";

export function registerLogHandlers(): void {
  // The renderer forwards its warnings and errors here; it is sandboxed and has
  // no log file of its own. Marked `process: "renderer"` so a line's origin is
  // never in doubt, and validated because everything crossing this boundary is
  // renderer-supplied. One-way: a log write must never throw back at the caller.
  ipcMain.on(CHANNELS.writeRendererLog, (_event, entry: RendererLogEntry) => {
    if (!entry || typeof entry.message !== "string") return;
    const fields = { process: "renderer", ...(entry.detail ?? {}) };
    if (entry.level === "error") logError(entry.message, fields);
    else warn(entry.message, fields);
  });

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
