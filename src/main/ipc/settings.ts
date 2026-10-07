import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import type { Settings } from "@shared/types";
import { SETTINGS_SET_KEYS, workspaceSetIssue } from "@shared/configSets";
import { getSettings, saveSettings } from "../storageAccess.js";
import { info } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";

export function registerSettingsHandlers(): void {
  ipcMain.handle(CHANNELS.getSettings, async (_event, wsId: string) => {
    const ws = await resolveWorkspace(wsId);
    const settings = await getSettings(ws.dataDirectory);
    info("settings loaded", { workspace: ws.id });
    return settings;
  });

  ipcMain.handle(CHANNELS.saveSettings, async (_event, wsId: string, body: unknown) => {
    const ws = await resolveWorkspace(wsId);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("settings must be an object");
    for (const key of SETTINGS_SET_KEYS) {
      const issue = Object.hasOwn(body, key) ? workspaceSetIssue(key, (body as Record<string, unknown>)[key]) : null;
      if (issue !== null) throw new Error(issue);
    }

    const settings = await saveSettings(ws.dataDirectory, body as Partial<Settings>);
    info("settings saved", {
      workspace: ws.id,
      timezone: settings.timezone,
      supportedLanguages: settings.supportedLanguages.length,
    });
    return settings;
  });
}
