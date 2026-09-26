import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import { appSettingsShapeIssue } from "@shared/appSettings";
import type { AppSettings } from "@shared/types";
import { getAppSettingsLoad, saveAppSettings } from "../core/services/appSettingsStore.js";
import { info } from "../core/services/logger.js";
import { changeLanguagePreference, interfaceLanguage } from "../i18n.js";
import { installApplicationMenu } from "../menu.js";
import { applyThemePreference } from "../theme.js";

export function registerAppSettingsHandlers(): void {
  ipcMain.handle(CHANNELS.getAppSettings, () => getAppSettingsLoad());

  ipcMain.handle(CHANNELS.getInterfaceLanguage, () => interfaceLanguage());

  ipcMain.handle(CHANNELS.saveAppSettings, (_event, settings: AppSettings) => {
    const issue = appSettingsShapeIssue(settings);
    if (issue !== null) throw new Error(`App settings rejected: ${issue}`);
    const saved = saveAppSettings(settings);
    applyThemePreference(saved.theme);
    // The window hears about a new language from the broadcast, and the menu
    // bar is rebuilt in it. macOS's own menu items follow at the next launch.
    changeLanguagePreference(saved.language, installApplicationMenu);
    info("app settings saved", { theme: saved.theme, language: saved.language });
    return saved;
  });
}
