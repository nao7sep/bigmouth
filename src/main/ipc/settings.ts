import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import type { Settings } from "@shared/types";
import { getSettings, saveSettings } from "../core/services/configStore.js";
import { info } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";

// Mirrors the old PUT /settings validation, throwing instead of returning 400.
function validateSettings(body: unknown): asserts body is Settings {
  const s = body as Partial<Record<keyof Settings, unknown>>;
  if (typeof s.timezone !== "string" || !s.timezone.trim()) {
    throw new Error("timezone must be a non-empty string");
  }
  if (!Array.isArray(s.supportedLanguages) || !s.supportedLanguages.every((l) => typeof l === "string")) {
    throw new Error("supportedLanguages must be an array of strings");
  }
  if (
    typeof s.publishedPostsPerLoad !== "number" ||
    !Number.isInteger(s.publishedPostsPerLoad) ||
    s.publishedPostsPerLoad < 1
  ) {
    throw new Error("publishedPostsPerLoad must be a positive integer");
  }
  if (typeof s.maxUploadMb !== "number" || !(s.maxUploadMb > 0)) {
    throw new Error("maxUploadMb must be a positive number");
  }
  if (typeof s.editorWatermark !== "string") {
    throw new Error("editorWatermark must be a string");
  }
  if (typeof s.extraFieldWatermark !== "string") {
    throw new Error("extraFieldWatermark must be a string");
  }
}

export function registerSettingsHandlers(): void {
  ipcMain.handle(CHANNELS.getSettings, (_event, wsId: string) => {
    const ws = resolveWorkspace(wsId);
    const settings = getSettings(ws.dataDirectory);
    info("settings loaded", { workspace: ws.id });
    return settings;
  });

  ipcMain.handle(CHANNELS.saveSettings, (_event, wsId: string, body: unknown) => {
    const ws = resolveWorkspace(wsId);
    validateSettings(body);
    const settings = saveSettings(ws.dataDirectory, body);
    info("settings saved", {
      workspace: ws.id,
      timezone: settings.timezone,
      supportedLanguages: settings.supportedLanguages.length,
    });
    return settings;
  });
}
