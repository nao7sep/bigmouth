/** App-wide choices stay in memory until the user edits their set. */

import type { AppSettings, AppSettingsLoad } from "@shared/types";
import {
  APP_SETTINGS_SET_KEYS,
  appSettingsSetHasShape,
  defaultAppSettings,
  normalizeAppSettings,
} from "@shared/appSettings";
import { setsDifferingFromBuiltIn } from "@shared/configSets";
import { message, type Message } from "@shared/i18n/translate";
import { writeSetFile } from "../shared/setFile.js";
import { moveAsideInvalid } from "../shared/quarantine.js";
import { NewerFormatError, readJsonStore } from "../shared/storeFormat.js";
import { getAppConfigPath } from "./storagePaths.js";
import { serializeError, warn } from "./logger.js";

let configPath: string | null = null;
let current: AppSettings | null = null;
let notice: Message | null = null;
// Set when a newer version of BigMouth wrote the file: it is never written.
let newerFormat: NewerFormatError | null = null;

function requirePath(): string {
  if (!configPath) throw new Error("appSettingsStore not initialized — call initAppSettingsStore() first");
  return configPath;
}

/**
 * Resolves config.json under the storage root and loads it. Must run after the
 * storage root and logger are initialized, and before the window exists: the
 * theme it carries is applied to the first frame.
 */
export function initAppSettingsStore(): AppSettings {
  configPath = getAppConfigPath();
  notice = null;
  newerFormat = null;

  const read = readJsonStore("appConfig", configPath);
  switch (read.kind) {
    case "absent":
      current = defaultAppSettings();
      return current;
    case "newer":
      // Left exactly as it is, so the version that wrote it can still read it.
      newerFormat = new NewerFormatError(configPath, read.version);
      warn("config.json was written by a newer version of BigMouth; left unchanged, app settings use their built-ins", {
        path: configPath,
        formatVersion: read.version,
      });
      notice = message("app.settingsNewer", { path: configPath });
      current = defaultAppSettings();
      return current;
    case "unreadable":
      return recover(configPath, read.detail, read.error);
    case "read":
      current = effectiveSettings(read.value);
      return current;
  }
}

// Recovery keeps built-ins in memory without replacing the quarantined file. A
// failed move propagates and stops startup, naming the file, rather than leaving
// its bytes where the next save would write over them.
function recover(filePath: string, detail: string, err: unknown): AppSettings {
  const movedTo = moveAsideInvalid(filePath);
  warn("config.json unusable; app settings reset", {
    path: filePath,
    detail,
    movedTo,
    ...(err ? { error: serializeError(err) } : {}),
  });
  notice = message("app.settingsRecovered", { path: movedTo });
  current = defaultAppSettings();
  return current;
}

export function getAppSettingsLoad(): AppSettingsLoad {
  if (!current) throw new Error("appSettingsStore not initialized — call initAppSettingsStore() first");
  return { settings: current, notice };
}

function effectiveSettings(map: Record<string, unknown>): AppSettings {
  const settings = defaultAppSettings();
  for (const key of APP_SETTINGS_SET_KEYS) {
    if (!Object.hasOwn(map, key)) continue;
    if (appSettingsSetHasShape(key, map[key])) Object.assign(settings, { [key]: map[key] });
    else warn("app config set is invalid; using built-in", { path: requirePath(), key });
  }
  return settings;
}

export function saveAppSettings(next: Partial<AppSettings>): AppSettings {
  if (!current) throw new Error("appSettingsStore not initialized — call initAppSettingsStore() first");
  if (newerFormat) throw newerFormat;
  const normalized = normalizeAppSettings({ ...current, ...next });
  writeSetFile("appConfig", requirePath(), setsDifferingFromBuiltIn(normalized, defaultAppSettings(), APP_SETTINGS_SET_KEYS));
  current = normalized;
  return normalized;
}
