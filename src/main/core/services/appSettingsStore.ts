/** App-wide choices stay in memory until the user edits their set. */

import type { AppSettings, AppSettingsLoad } from "@shared/types";
import {
  APP_SETTINGS_SET_KEYS,
  appSettingsSetHasShape,
  defaultAppSettings,
  normalizeAppSettings,
} from "@shared/appSettings";
import { keptStoredSets, setsDifferingFromBuiltIn } from "@shared/configSets";
import { message, type Message } from "@shared/i18n/translate";
import { writeSetFile } from "../shared/setFile.js";
import { moveAsideInvalid } from "../shared/quarantine.js";
import { NewerFormatError, UnreadableStoreError, readJsonStore } from "../shared/storeFormat.js";
import { getAppConfigPath } from "./storagePaths.js";
import { serializeError, warn } from "./logger.js";

let configPath: string | null = null;
let current: AppSettings | null = null;
let notice: Message | null = null;
// Why saves must leave config.json as it is this launch: a newer build wrote it,
// or it could not be read. Decided once at load; nothing else writes the file.
let refusal: Error | null = null;
// The file's sets as read, so a save keeps the ones this build cannot use.
let stored: Record<string, unknown> = {};

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
  refusal = null;
  stored = {};

  const read = readJsonStore("appConfig", configPath);
  switch (read.kind) {
    case "absent":
      current = defaultAppSettings();
      return current;
    case "newer":
      // Left exactly as it is, so the version that wrote it can still read it.
      warn("config.json was written by a newer version of BigMouth; left unchanged, app settings use their built-ins", {
        path: configPath,
        formatVersion: read.version,
      });
      notice = message("app.settingsNewer", { path: configPath });
      refusal = new NewerFormatError(configPath, read.version);
      current = defaultAppSettings();
      return current;
    case "inaccessible":
      // A failed read says nothing about the bytes, so the file is neither moved
      // nor replaced: built-ins for this launch, and saves refused.
      warn("config.json could not be read; left unchanged, app settings use their built-ins", {
        path: configPath,
        detail: read.detail,
        error: serializeError(read.error),
      });
      notice = message("app.settingsInaccessible", { path: configPath });
      refusal = new UnreadableStoreError(configPath, read.detail, read.error);
      current = defaultAppSettings();
      return current;
    case "unreadable":
      return recover(configPath, read.detail, read.error);
    case "read":
      stored = read.value;
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
  if (refusal) throw refusal;
  const normalized = normalizeAppSettings({ ...current, ...next });
  const previous = current;
  const sets = setsDifferingFromBuiltIn(normalized, defaultAppSettings(), APP_SETTINGS_SET_KEYS);
  const kept = keptStoredSets(
    stored,
    APP_SETTINGS_SET_KEYS,
    (key, value) => appSettingsSetHasShape(key as (typeof APP_SETTINGS_SET_KEYS)[number], value),
    (key) => normalized[key as keyof AppSettings] !== previous[key as keyof AppSettings],
  );
  const written = { ...sets, ...kept };
  writeSetFile("appConfig", requirePath(), written);
  stored = written;
  current = normalized;
  return normalized;
}
