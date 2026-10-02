/** App-wide choices stay in memory until the user edits their set. */

import fs from "node:fs";
import type { AppSettings, AppSettingsLoad } from "@shared/types";
import {
  APP_SETTINGS_SET_KEYS,
  appSettingsSetHasShape,
  appSettingsShapeIssue,
  defaultAppSettings,
  normalizeAppSettings,
} from "@shared/appSettings";
import { setsDifferingFromBuiltIn } from "@shared/configSets";
import { writeSetFile } from "../shared/setFile.js";
import { moveAsideInvalid } from "../shared/quarantine.js";
import { getAppConfigPath } from "./storagePaths.js";
import { serializeError, warn } from "./logger.js";

let configPath: string | null = null;
let current: AppSettings | null = null;
let quarantinedTo: string | null = null;

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
  quarantinedTo = null;

  let text: string | null = null;
  try {
    text = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return recover(configPath, `it could not be read (${(err as Error).message})`, err);
    }
  }

  if (text === null) {
    current = defaultAppSettings();
    return current;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return recover(configPath, "it is not valid JSON", err);
  }
  const issue = appSettingsShapeIssue(parsed);
  if (issue !== null) return recover(configPath, issue, null);

  current = effectiveSettings(parsed as Record<string, unknown>);
  return current;
}

// Recovery keeps built-ins in memory without replacing the quarantined file.
function recover(filePath: string, detail: string, err: unknown): AppSettings {
  const movedTo = moveAsideInvalid(filePath);
  warn("config.json unusable; app settings reset", {
    path: filePath,
    detail,
    movedTo,
    ...(err ? { error: serializeError(err) } : {}),
  });
  if (movedTo === null) {
    current = defaultAppSettings();
    return current;
  }
  quarantinedTo = movedTo;
  current = defaultAppSettings();
  return current;
}

export function getAppSettingsLoad(): AppSettingsLoad {
  if (!current) throw new Error("appSettingsStore not initialized — call initAppSettingsStore() first");
  return { settings: current, quarantinedTo };
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
  writeSetFile(requirePath(), setsDifferingFromBuiltIn(normalized, defaultAppSettings(), APP_SETTINGS_SET_KEYS));
  current = normalized;
  return normalized;
}
