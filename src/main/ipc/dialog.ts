import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, dialog, ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import { info, warn, serializeError } from "../core/services/logger.js";
import { expandWorkspacePath } from "../core/services/storagePaths.js";
import { suggestWorkspaceLocation } from "../storageAccess.js";
import { mainTranslator } from "../i18n.js";

// Proposed destinations need not exist. Opening a picker never creates them;
// walk to an available ancestor instead, including past a file or removed drive.
async function existingDirectory(directory: string): Promise<string | undefined> {
  let candidate = expandWorkspacePath(directory);
  for (;;) {
    try {
      if ((await fs.stat(candidate)).isDirectory()) return candidate;
    } catch {
      // An unavailable hint must not prevent choosing a different destination.
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

export function registerDialogHandlers(): void {
  ipcMain.handle(CHANNELS.pickDirectory, async (event, purpose: unknown, initialDirectory?: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const creating = purpose === "create";
    let initial = typeof initialDirectory === "string" && initialDirectory ? initialDirectory : undefined;
    if (!initial && creating) {
      try {
        initial = await suggestWorkspaceLocation();
      } catch (error) {
        // A failed default proposal must still allow choosing a destination.
        warn("workspace picker default unavailable", { error: serializeError(error) });
      }
    } else if (initial && !creating) initial = path.dirname(expandWorkspacePath(initial));
    const options: Electron.OpenDialogOptions = {
      title: mainTranslator().t(creating ? "workspaces.createPickerTitle" : "workspaces.pickerTitle"),
      properties: creating ? ["openDirectory", "createDirectory"] : ["openDirectory"],
      ...(initial ? { defaultPath: await existingDirectory(initial) } : {}),
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    info("workspace directory picked");
    return result.filePaths[0];
  });
}
