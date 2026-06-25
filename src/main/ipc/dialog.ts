import { BrowserWindow, dialog, ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import { info } from "../core/services/logger.js";

export function registerDialogHandlers(): void {
  // Native folder picker for choosing a workspace directory — the desktop
  // replacement for typing a path. Returns the chosen absolute path, or null if
  // the user cancelled. The store's own path-expansion/validation still applies.
  ipcMain.handle(CHANNELS.pickDirectory, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: "Choose a workspace folder",
      properties: ["openDirectory", "createDirectory"],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    info("workspace directory picked");
    return result.filePaths[0];
  });
}
