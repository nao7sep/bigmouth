import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import { appSettingsShapeIssue } from "@shared/appSettings";
import type { AppSettings } from "@shared/types";
import { getAppSettingsLoad, saveAppSettings } from "../core/services/appSettingsStore.js";
import { info } from "../core/services/logger.js";
import { applyThemePreference } from "../theme.js";

export function registerAppSettingsHandlers(): void {
  ipcMain.handle(CHANNELS.getAppSettings, () => getAppSettingsLoad());

  ipcMain.handle(CHANNELS.saveAppSettings, (_event, settings: AppSettings) => {
    const issue = appSettingsShapeIssue(settings);
    if (issue !== null) throw new Error(`App settings rejected: ${issue}`);
    const saved = saveAppSettings(settings);
    applyThemePreference(saved.theme);
    info("app settings saved", { theme: saved.theme });
    return saved;
  });
}
