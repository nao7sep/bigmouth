import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import { APP_SETTINGS_SET_KEYS, appSettingsSetHasShape, appSettingsShapeIssue } from "@shared/appSettings";
import type { AppSettings } from "@shared/types";
import { getAppSettingsLoad, saveAppSettings } from "../core/services/appSettingsStore.js";
import { info } from "../core/services/logger.js";
import { changeLanguagePreference, interfaceLanguage } from "../i18n.js";
import { installApplicationMenu } from "../menu.js";
import { applyThemePreference } from "../theme.js";

export function registerAppSettingsHandlers(): void {
  ipcMain.handle(CHANNELS.getAppSettings, () => getAppSettingsLoad());

  ipcMain.handle(CHANNELS.getInterfaceLanguage, () => interfaceLanguage());

  ipcMain.handle(CHANNELS.saveAppSettings, async (_event, settings: Partial<AppSettings>) => {
    const issue = appSettingsShapeIssue(settings);
    if (issue !== null) throw new Error(`App settings rejected: ${issue}`);
    for (const key of APP_SETTINGS_SET_KEYS) {
      if (Object.hasOwn(settings, key) && !appSettingsSetHasShape(key, settings[key])) throw new Error(`App settings rejected: invalid ${key}`);
    }
    const saved = saveAppSettings(settings);
    applyThemePreference(saved.theme);
    // The window hears about a new language from the broadcast, and the menu
    // bar is rebuilt in it. macOS's own menu items follow at the next launch.
    await changeLanguagePreference(saved.language, installApplicationMenu);
    info("app settings saved", { theme: saved.theme, language: saved.language });
    return saved;
  });
}
