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
import { writeManagedText } from "../shared/atomicWrite.js";
import { moveAsideInvalid } from "../shared/quarantine.js";
import { getAppConfigPath } from "./storagePaths.js";
import { serializeError, warn } from "./logger.js";

const warnedSets = new Set<string>();
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
    else {
      const warningId = `${requirePath()}:${key}`;
      if (!warnedSets.has(warningId)) {
        warnedSets.add(warningId);
        warn("app config set has invalid shape; using built-in", { path: requirePath(), key });
      }
    }
  }
  return settings;
}

/** Writes changed sets while preserving the file's other known copies. */
export function saveAppSettings(next: Partial<AppSettings>): AppSettings {
  let map: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(requirePath(), "utf-8"));
    const issue = appSettingsShapeIssue(parsed);
    if (issue) throw new Error(`App settings rejected: ${issue}`);
    map = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const previous = effectiveSettings(map);
  const normalized = normalizeAppSettings({ ...previous, ...next });
  const saved: Record<string, unknown> = {};
  let changed = false;
  for (const key of APP_SETTINGS_SET_KEYS) {
    if (Object.hasOwn(map, key)) saved[key] = map[key];
    if (Object.hasOwn(next, key) && normalized[key] !== previous[key]) {
      saved[key] = normalized[key];
      changed = true;
    }
  }
  if (changed) writeManagedText(requirePath(), JSON.stringify(saved, null, 2) + "\n");
  current = normalized;
  return normalized;
}
