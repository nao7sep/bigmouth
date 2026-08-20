import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import type { ContentFont, Settings } from "@shared/types";
import { firstSettingsError } from "@shared/settingsValidation";
import { getSettings, saveSettings } from "../core/services/configStore.js";
import { info } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";

/**
 * Validates the settings payload; throws on the first invalid field.
 *
 * TYPE narrowing only — the payload arrives from the renderer as `unknown`, so
 * something has to establish that it is a Settings at all. The VALUE rules
 * (which timezones resolve, which language codes are legal, which numbers are
 * in range) live in `@shared/settingsValidation` and are applied by the handler,
 * so the modal's messages and this gate cannot disagree. They had: maxUploadMb
 * was "integer >= 1" on screen and "> 0" here.
 */
function validateSettings(body: unknown): asserts body is Settings {
  const s = body as Partial<Record<keyof Settings, unknown>>;
  if (typeof s.timezone !== "string" || !s.timezone.trim()) {
    throw new Error("timezone must be a non-empty string");
  }
  if (!Array.isArray(s.supportedLanguages) || !s.supportedLanguages.every((l) => typeof l === "string")) {
    throw new Error("supportedLanguages must be an array of strings");
  }
  if (typeof s.publishedPostsPerLoad !== "number") {
    throw new Error("publishedPostsPerLoad must be a number");
  }
  if (typeof s.maxUploadMb !== "number") {
    throw new Error("maxUploadMb must be a number");
  }
  if (typeof s.editorWatermark !== "string") {
    throw new Error("editorWatermark must be a string");
  }
  if (typeof s.extraFieldWatermark !== "string") {
    throw new Error("extraFieldWatermark must be a string");
  }
  if (typeof s.uiFontFamily !== "string") {
    throw new Error("uiFontFamily must be a string");
  }
  validateContentFont(s.contentFont);
}

function validateContentFont(value: unknown): asserts value is ContentFont {
  if (typeof value !== "object" || value === null) {
    throw new Error("contentFont must be an object");
  }
  const f = value as Partial<Record<keyof ContentFont, unknown>>;
  if (typeof f.family !== "string") {
    throw new Error("contentFont.family must be a string");
  }
  if (typeof f.size !== "number" || typeof f.lineHeight !== "number" || typeof f.padding !== "number") {
    throw new Error("contentFont.size, .lineHeight, and .padding must be numbers");
  }
  if (typeof f.bold !== "boolean" || typeof f.italic !== "boolean" || typeof f.underline !== "boolean") {
    throw new Error("contentFont.bold, .italic, and .underline must be booleans");
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
    // The value rules, from the same module the modal renders its messages from.
    const invalid = firstSettingsError(body);
    if (invalid) throw new Error(`${invalid.field}: ${invalid.message}`);

    const settings = saveSettings(ws.dataDirectory, body);
    info("settings saved", {
      workspace: ws.id,
      timezone: settings.timezone,
      supportedLanguages: settings.supportedLanguages.length,
    });
    return settings;
  });
}
