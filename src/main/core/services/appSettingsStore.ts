/**
 * App-settings I/O.
 *
 * Manages ~/.bigmouth/config.json — the user's app-wide choices (the theme),
 * which apply in every workspace. It is authored configuration, a separate
 * persisted kind from the workspace registry, each workspace's own config.json,
 * and the view state in state.json (persisted-store-separation conventions), so
 * it follows the storage-path rules for settings:
 *   - Materialized on first launch from the in-code defaults, through the same
 *     save path a Settings change uses, and only when the file is absent.
 *   - A file that cannot be read or does not fit its shape is moved aside to
 *     `config-<stamp>.invalid`, reset to the defaults, and reported to the user
 *     through AppSettingsLoad.quarantinedTo — never coerced and overwritten.
 *   - Recorded on every save, like every other managed text store.
 */

import fs from "node:fs";
import type { AppSettings, AppSettingsLoad } from "@shared/types";
import {
  appSettingsShapeIssue,
  defaultAppSettings,
  normalizeAppSettings,
} from "@shared/appSettings";
import { writeManagedText } from "../shared/atomicWrite.js";
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
    // First launch (or the user removed it): materialize the defaults.
    return saveAppSettings(defaultAppSettings());
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return recover(configPath, "it is not valid JSON", err);
  }
  const issue = appSettingsShapeIssue(parsed);
  if (issue !== null) return recover(configPath, issue, null);

  current = normalizeAppSettings(parsed);
  return current;
}

// Quarantine-then-reset: the defaults are materialized in the same launch
// through the ordinary save path. When the file cannot even be moved aside, the
// defaults stay in memory and nothing is written over it.
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
  return saveAppSettings(defaultAppSettings());
}

export function getAppSettingsLoad(): AppSettingsLoad {
  if (!current) throw new Error("appSettingsStore not initialized — call initAppSettingsStore() first");
  return { settings: current, quarantinedTo };
}

/** Normalizes, persists, and returns the saved settings. */
export function saveAppSettings(next: AppSettings): AppSettings {
  const normalized = normalizeAppSettings(next);
  writeManagedText(requirePath(), JSON.stringify(normalized, null, 2) + "\n");
  current = normalized;
  return normalized;
}
