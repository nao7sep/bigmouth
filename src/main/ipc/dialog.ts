import { BrowserWindow, dialog, ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import { info } from "../core/services/logger.js";
import { mainTranslator } from "../i18n.js";

export function registerDialogHandlers(): void {
  // Native folder picker, the only way a workspace path is chosen: a folder
  // holding a workspace to add, or the parent a new workspace's folder goes in.
  // Returns the chosen absolute path, or null if the user cancelled. The store's
  // own path-expansion/validation still applies.
  ipcMain.handle(CHANNELS.pickDirectory, async (event, purpose: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const parent = purpose === "parent";
    const options: Electron.OpenDialogOptions = {
      title: mainTranslator().t(parent ? "workspaces.parentPickerTitle" : "workspaces.pickerTitle"),
      properties: parent ? ["openDirectory", "createDirectory"] : ["openDirectory"],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    info("workspace directory picked");
    return result.filePaths[0];
  });
}
