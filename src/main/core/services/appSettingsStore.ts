/** App-wide choices stay in memory until the user edits their set. */

import type { AppSettings, AppSettingsLoad } from "@shared/types";
import {
  APP_SETTINGS_SET_KEYS,
  appSettingsSetHasShape,
  defaultAppSettings,
  normalizeAppSettings,
} from "@shared/appSettings";
import { keptStoredSets, setsDifferingFromBuiltIn } from "@shared/configSets";
import { writeSetFile } from "../shared/setFile.js";
import { NewerFormatError, UnreadableStoreError, readJsonStore } from "../shared/storeFormat.js";
import { getAppConfigPath } from "./storagePaths.js";
import { warn } from "./logger.js";
import { startupNotices } from "./startupNotices.js";

let configPath: string | null = null;
let current: AppSettings | null = null;
// The file's sets as read, so a save keeps the ones this build cannot use.
let stored: Record<string, unknown> = {};

function requirePath(): string {
  if (!configPath) throw new Error("appSettingsStore not initialized — call initAppSettingsStore() first");
  return configPath;
}

/**
 * Resolves config.json under the storage root and loads it. Must run after the
 * storage root and logger are initialized, and before the window exists: the
 * theme it carries is applied to the first frame. A file a newer build wrote, or
 * one that cannot be read, stops the launch before this runs (launchCheck); met
 * here all the same, it throws, naming the file, and nothing is written.
 */
export function initAppSettingsStore(): AppSettings {
  configPath = getAppConfigPath();
  current = null;
  stored = {};

  const read = readJsonStore("appConfig", configPath);
  switch (read.kind) {
    case "absent":
      current = defaultAppSettings();
      return current;
    case "newer":
      throw new NewerFormatError(configPath, read.version);
    case "inaccessible":
    case "unreadable":
      throw new UnreadableStoreError(configPath, read.detail, read.error);
    case "read":
      stored = read.value;
      current = effectiveSettings(read.value);
      return current;
  }
}

export function getAppSettingsLoad(): AppSettingsLoad {
  if (!current) throw new Error("appSettingsStore not initialized — call initAppSettingsStore() first");
  return { settings: current, notices: startupNotices() };
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
