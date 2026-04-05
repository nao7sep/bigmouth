/**
 * Data directory initialization and resolution.
 *
 * On first run, creates:
 *   ~/.bigmouth/app.json          (fixed location, contains dataDirectory path)
 *   ~/.bigmouth/data/             (default data directory)
 *   ~/.bigmouth/data/posts/
 *   ~/.bigmouth/data/assets/
 *   ~/.bigmouth/data/logs/
 *   ~/.bigmouth/data/settings.json
 *   ~/.bigmouth/data/targets.json
 *   ~/.bigmouth/data/prompts.json
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DEFAULT_SETTINGS, DEFAULT_PROMPTS } from "../shared/defaults.js";
import type { Target } from "../shared/types.js";

const APP_DIR = path.join(os.homedir(), ".bigmouth");
const APP_JSON_PATH = path.join(APP_DIR, "app.json");

interface AppConfig {
  dataDirectory: string;
}

/**
 * Reads app.json and returns the data directory path.
 * If app.json or the data directory doesn't exist, creates everything.
 */
export function resolveDataDirectory(): string {
  let config: AppConfig;

  if (fs.existsSync(APP_JSON_PATH)) {
    const raw = fs.readFileSync(APP_JSON_PATH, "utf-8");
    config = JSON.parse(raw) as AppConfig;
  } else {
    // First run: create app.json with default data directory
    const defaultDataDir = path.join(APP_DIR, "data");
    config = { dataDirectory: defaultDataDir };

    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.writeFileSync(APP_JSON_PATH, JSON.stringify(config, null, 2) + "\n");
  }

  initializeDataDirectory(config.dataDirectory);
  return config.dataDirectory;
}

/**
 * Ensures the data directory and all required subdirectories and files exist.
 * Only creates what is missing — never overwrites existing files.
 */
function initializeDataDirectory(dataDir: string): void {
  // Create directories
  for (const sub of ["posts", "assets", "logs"]) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }

  // Create default files only if they don't exist
  writeIfMissing(
    path.join(dataDir, "settings.json"),
    JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n"
  );

  const emptyTargets: Target[] = [];
  writeIfMissing(
    path.join(dataDir, "targets.json"),
    JSON.stringify(emptyTargets, null, 2) + "\n"
  );

  writeIfMissing(
    path.join(dataDir, "prompts.json"),
    JSON.stringify(DEFAULT_PROMPTS, null, 2) + "\n"
  );
}

function writeIfMissing(filePath: string, content: string): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
  }
}

/**
 * Returns the path to app.json (for reference/debugging).
 */
export function getAppJsonPath(): string {
  return APP_JSON_PATH;
}
