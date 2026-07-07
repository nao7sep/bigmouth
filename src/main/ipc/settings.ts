import { ipcMain } from "electron";

import { CHANNELS } from "@shared/ipc";
import type { ContentFont, Settings } from "@shared/types";
import {
  CONTENT_FONT_SIZE_MAX,
  CONTENT_FONT_SIZE_MIN,
  CONTENT_LINE_HEIGHT_MAX,
  CONTENT_LINE_HEIGHT_MIN,
  CONTENT_PADDING_MAX,
  CONTENT_PADDING_MIN,
} from "@shared/types";
import { getSettings, saveSettings } from "../core/services/configStore.js";
import { info } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";

// Validates the settings payload; throws on the first invalid field.
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
  if (
    typeof f.size !== "number" ||
    !Number.isFinite(f.size) ||
    f.size < CONTENT_FONT_SIZE_MIN ||
    f.size > CONTENT_FONT_SIZE_MAX
  ) {
    throw new Error(`contentFont.size must be a number between ${CONTENT_FONT_SIZE_MIN} and ${CONTENT_FONT_SIZE_MAX}`);
  }
  if (
    typeof f.lineHeight !== "number" ||
    !Number.isFinite(f.lineHeight) ||
    f.lineHeight < CONTENT_LINE_HEIGHT_MIN ||
    f.lineHeight > CONTENT_LINE_HEIGHT_MAX
  ) {
    throw new Error(
      `contentFont.lineHeight must be a number between ${CONTENT_LINE_HEIGHT_MIN} and ${CONTENT_LINE_HEIGHT_MAX}`
    );
  }
  if (
    typeof f.padding !== "number" ||
    !Number.isFinite(f.padding) ||
    f.padding < CONTENT_PADDING_MIN ||
    f.padding > CONTENT_PADDING_MAX
  ) {
    throw new Error(`contentFont.padding must be a number between ${CONTENT_PADDING_MIN} and ${CONTENT_PADDING_MAX}`);
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
    const settings = saveSettings(ws.dataDirectory, body);
    info("settings saved", {
      workspace: ws.id,
      timezone: settings.timezone,
      supportedLanguages: settings.supportedLanguages.length,
    });
    return settings;
  });
}
