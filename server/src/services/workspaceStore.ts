/**
 * Workspace registry I/O.
 *
 * Manages ~/.bigmouth/app.json which contains the port and workspace list.
 * Each workspace entry has an id, name, and absolute dataDirectory path.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { nanoid } from "nanoid";
import type { AppConfig, Workspace } from "../shared/types.js";
import { DEFAULT_PORT } from "../shared/defaults.js";
import { initializeWorkspaceData } from "./dataDir.js";

const APP_DIR = path.join(os.homedir(), ".bigmouth");
const APP_JSON_PATH = path.join(APP_DIR, "app.json");
const LOGS_DIR = path.join(APP_DIR, "logs");
const DEFAULT_WORKSPACES_DIR = path.join(APP_DIR, "workspaces");

let appConfig: AppConfig | null = null;

function defaultAppConfig(): AppConfig {
  return { port: DEFAULT_PORT, workspaces: [] };
}

/**
 * Expands shell-style home directory shorthands and resolves to an absolute path.
 *   ~/foo        → /home/user/foo   (Unix/Mac)
 *   ~\foo        → C:\Users\user\foo (Windows)
 *   %USERPROFILE%\foo → C:\Users\user\foo (Windows)
 *   %HOME%/foo   → /home/user/foo
 */
function expandPath(p: string): string {
  // Expand leading ~ to the home directory
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    p = os.homedir() + p.slice(1);
  }
  // Expand %VAR% style placeholders (common on Windows)
  p = p.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`);
  return path.resolve(p);
}

/**
 * Ensures ~/.bigmouth/ and logs/ exist. Loads or creates app.json.
 * Must be called once at startup.
 */
export function initAppDir(): AppConfig {
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  if (fs.existsSync(APP_JSON_PATH)) {
    const raw = fs.readFileSync(APP_JSON_PATH, "utf-8");
    appConfig = JSON.parse(raw) as AppConfig;
  } else {
    appConfig = defaultAppConfig();
    writeAppConfig();
  }

  return appConfig;
}

function writeAppConfig(): void {
  fs.writeFileSync(APP_JSON_PATH, JSON.stringify(appConfig, null, 2) + "\n");
}

function ensureLoaded(): AppConfig {
  if (!appConfig) throw new Error("workspaceStore not initialized — call initAppDir() first");
  return appConfig;
}

export function getAppConfig(): AppConfig {
  return ensureLoaded();
}

export function getLogsDir(): string {
  return LOGS_DIR;
}

export function listWorkspaces(): Workspace[] {
  return ensureLoaded().workspaces;
}

export function getWorkspace(id: string): Workspace | undefined {
  return ensureLoaded().workspaces.find((w) => w.id === id);
}

export function createWorkspace(name: string, dataDirectory?: string): Workspace {
  const config = ensureLoaded();
  const id = nanoid();
  const dir = dataDirectory ? expandPath(dataDirectory) : path.join(DEFAULT_WORKSPACES_DIR, id);

  const workspace: Workspace = { id, name, dataDirectory: dir };

  // Initialize the data directory with default files
  initializeWorkspaceData(dir);

  config.workspaces.push(workspace);
  writeAppConfig();

  return workspace;
}

export function updateWorkspace(id: string, updates: { name?: string; dataDirectory?: string }): Workspace | null {
  const config = ensureLoaded();
  const ws = config.workspaces.find((w) => w.id === id);
  if (!ws) return null;

  if (updates.name !== undefined) ws.name = updates.name;
  if (updates.dataDirectory !== undefined) ws.dataDirectory = expandPath(updates.dataDirectory);

  writeAppConfig();
  return ws;
}

export function deleteWorkspace(id: string): boolean {
  const config = ensureLoaded();
  const index = config.workspaces.findIndex((w) => w.id === id);
  if (index === -1) return false;

  const ws = config.workspaces[index];

  // Remove the data directory if it exists
  if (fs.existsSync(ws.dataDirectory)) {
    fs.rmSync(ws.dataDirectory, { recursive: true });
  }

  config.workspaces.splice(index, 1);
  writeAppConfig();
  return true;
}
