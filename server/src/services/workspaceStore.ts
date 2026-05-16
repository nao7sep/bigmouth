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
import { DEFAULT_ALLOWED_ORIGINS, DEFAULT_HOST, DEFAULT_PORT } from "../shared/defaults.js";
import { initializeWorkspaceData } from "./dataDir.js";

const APP_DIR = path.join(os.homedir(), ".bigmouth");
const APP_JSON_PATH = path.join(APP_DIR, "app.json");
const LOGS_DIR = path.join(APP_DIR, "logs");
const DEFAULT_WORKSPACES_DIR = path.join(APP_DIR, "workspaces");

let appConfig: AppConfig | null = null;

function defaultAppConfig(): AppConfig {
  return {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    allowedOrigins: [...DEFAULT_ALLOWED_ORIGINS],
    workspaces: [],
  };
}

function parseAppConfig(raw: unknown): AppConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid app.json: expected an object");
  }

  const source = raw as Record<string, unknown>;
  if (typeof source.port !== "number" || !Number.isFinite(source.port)) {
    throw new Error("Invalid app.json: port must be a number");
  }
  if (typeof source.host !== "string" || !source.host.trim()) {
    throw new Error("Invalid app.json: host must be a non-empty string");
  }
  if (
    !Array.isArray(source.allowedOrigins) ||
    source.allowedOrigins.some((value) => typeof value !== "string")
  ) {
    throw new Error("Invalid app.json: allowedOrigins must be an array of strings");
  }
  if (!Array.isArray(source.workspaces)) {
    throw new Error("Invalid app.json: workspaces must be an array");
  }

  const workspaces = source.workspaces.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("Invalid app.json: each workspace must be an object");
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.name !== "string" ||
      typeof record.dataDirectory !== "string"
    ) {
      throw new Error("Invalid app.json: each workspace needs id, name, and dataDirectory");
    }
    return {
      id: record.id,
      name: record.name,
      dataDirectory: record.dataDirectory,
    };
  });

  return {
    port: source.port,
    host: source.host.trim(),
    allowedOrigins: [...source.allowedOrigins],
    workspaces,
  };
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
    const parsed = JSON.parse(raw) as unknown;
    appConfig = parseAppConfig(parsed);
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

/**
 * Returns true only when the directory has the required bigmouth workspace
 * shape. Partially present workspace files are treated as broken, not as a
 * workspace to repair.
 */
function isWorkspaceDirectory(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) return false;

  const requiredFiles = [
    "settings.json",
    "ai-configs.json",
    "targets.json",
    "analysis-prompts.json",
    "generation-prompts.json",
  ];
  const requiredDirs = [
    "posts",
    "posts/drafts",
    "posts/ready",
    "posts/published",
    "assets",
  ];

  return (
    requiredFiles.every((entry) => fs.existsSync(path.join(dir, entry))) &&
    requiredDirs.every((entry) => {
      const entryPath = path.join(dir, entry);
      return fs.existsSync(entryPath) && fs.statSync(entryPath).isDirectory();
    })
  );
}

function isEmptyDirectory(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) return false;
  return fs.readdirSync(dir).length === 0;
}

function findWorkspaceByDirectory(dir: string): Workspace | undefined {
  const normalized = expandPath(dir);
  return ensureLoaded().workspaces.find((workspace) => workspace.dataDirectory === normalized);
}

function nextWorkspaceName(): string {
  const names = new Set(
    ensureLoaded().workspaces.map((workspace) => workspace.name.trim().toLowerCase())
  );
  if (!names.has("workspace")) return "Workspace";

  let index = 2;
  while (names.has(`workspace ${index}`)) {
    index += 1;
  }
  return `Workspace ${index}`;
}

function resolveWorkspaceName(name: string | undefined, dataDirectory: string | undefined): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  if (dataDirectory) return path.basename(dataDirectory);
  return nextWorkspaceName();
}

export function createWorkspace(name: string, dataDirectory?: string): Workspace {
  const config = ensureLoaded();
  const id = nanoid();

  let dir: string;
  if (dataDirectory) {
    dir = expandPath(dataDirectory);
    const existing = findWorkspaceByDirectory(dir);
    if (existing) {
      throw new Error(`That folder is already registered as workspace "${existing.name}".`);
    }
    if (fs.existsSync(dir)) {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) {
        throw new Error("Location must be a directory.");
      }
      if (isWorkspaceDirectory(dir)) {
        throw new Error("That folder already contains a workspace. Use Open instead.");
      }
      if (!isEmptyDirectory(dir)) {
        throw new Error("New workspaces can only be created in an empty folder.");
      }
    }
  } else {
    dir = path.join(DEFAULT_WORKSPACES_DIR, id);
  }

  const workspace: Workspace = { id, name, dataDirectory: dir };

  // Initialize the data directory with default files
  initializeWorkspaceData(dir);

  config.workspaces.push(workspace);
  writeAppConfig();

  return workspace;
}

export function openWorkspace(dataDirectory: string, name?: string): Workspace {
  const config = ensureLoaded();
  const dir = expandPath(dataDirectory);
  const existing = findWorkspaceByDirectory(dir);
  if (existing) {
    return existing;
  }
  if (!isWorkspaceDirectory(dir)) {
    throw new Error("Choose an existing bigmouth workspace folder.");
  }

  const workspace: Workspace = {
    id: nanoid(),
    name: name?.trim() || path.basename(dir),
    dataDirectory: dir,
  };

  config.workspaces.push(workspace);
  writeAppConfig();
  return workspace;
}

export function openOrCreateWorkspace(name?: string, dataDirectory?: string): Workspace {
  const trimmedDir = dataDirectory?.trim();
  if (!trimmedDir) {
    return createWorkspace(resolveWorkspaceName(name, undefined));
  }

  const dir = expandPath(trimmedDir);
  const existing = findWorkspaceByDirectory(dir);
  if (existing) {
    return existing;
  }
  if (fs.existsSync(dir)) {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) {
      throw new Error("Location must be a directory.");
    }
    if (isWorkspaceDirectory(dir)) {
      return openWorkspace(dir, name);
    }
    if (!isEmptyDirectory(dir)) {
      throw new Error("Location must be empty or already contain a bigmouth workspace.");
    }
  }

  return createWorkspace(resolveWorkspaceName(name, dir), dir);
}

export function updateWorkspace(id: string, updates: { name?: string; dataDirectory?: string }): Workspace | null {
  const config = ensureLoaded();
  const ws = config.workspaces.find((w) => w.id === id);
  if (!ws) return null;

  if (updates.name !== undefined) ws.name = updates.name;
  if (updates.dataDirectory !== undefined) {
    const newDir = expandPath(updates.dataDirectory);
    const existing = findWorkspaceByDirectory(newDir);
    if (existing && existing.id !== id) {
      throw new Error(`That folder is already registered as workspace "${existing.name}".`);
    }
    if (!isEmptyDirectory(newDir) && !isWorkspaceDirectory(newDir)) {
      throw new Error("Workspace location must be an empty folder or an existing workspace.");
    }
    ws.dataDirectory = newDir;
  }

  writeAppConfig();
  return ws;
}

export function deleteWorkspace(id: string): boolean {
  const config = ensureLoaded();
  const index = config.workspaces.findIndex((w) => w.id === id);
  if (index === -1) return false;

  config.workspaces.splice(index, 1);
  writeAppConfig();
  return true;
}
