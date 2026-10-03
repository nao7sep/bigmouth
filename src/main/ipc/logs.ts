import { ipcMain } from "electron";

import { CHANNELS, type RendererLogEntry } from "@shared/ipc";
import { error as logError, warn } from "../core/services/logger.js";

export function registerLogHandlers(): void {
  // The renderer forwards its warnings and errors here; it is sandboxed and
  // cannot write records itself. Marked `process: "renderer"` so a line's origin is
  // never in doubt, and validated because everything crossing this boundary is
  // renderer-supplied. One-way: a log write must never throw back at the caller.
  ipcMain.on(CHANNELS.writeRendererLog, (_event, entry: RendererLogEntry) => {
    if (!entry || typeof entry.message !== "string") return;
    const fields = { process: "renderer", ...(entry.detail ?? {}) };
    if (entry.level === "error") logError(entry.message, fields);
    else warn(entry.message, fields);
  });
}
