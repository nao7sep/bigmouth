/**
 * Workspace registry I/O.
 *
 * Manages ~/.bigmouth/app.json which contains the workspace list.
 * Each workspace entry has an id, name, and absolute dataDirectory path.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { nanoid } from "nanoid";
import type { AppConfig, Workspace } from "../shared/types.js";
import { writeFileAtomic } from "../shared/atomicWrite.js";
import { isWorkspaceConfig } from "../shared/workspaceConfigShape.js";
import { initializeWorkspaceData } from "./dataDir.js";
import { clearWorkspaceKeys } from "./apiKeys.js";
import { forgetWorkspace } from "./activeConfig.js";

const APP_NAME = "bigmouth";
const HOME_ENV_VAR = "BIGMOUTH_HOME";

// The single storage root and the paths derived from it. Resolved once, lazily,
// in initAppDir() rather than frozen at import time — so a BIGMOUTH_HOME set
// just before startup (e.g. by a test) is honored, and the resolver never
// captures a half-set environment.
let appDir: string | null = null;
let appJsonPath: string | null = null;
let logsDir: string | null = null;
let apiKeysPath: string | null = null;
let defaultWorkspacesDir: string | null = null;

/**
 * The single path-expansion pipeline for the app. Expands a leading ~ / ~/ / ~\
 * to `base`, substitutes $VAR / %VAR% environment references (an unknown
 * reference is left literal), and resolves the result to an absolute path
 * against `base` — never against the working directory, so a relative value can
 * never be interpreted relative to how the app happened to be launched.
 *
 * Both the BIGMOUTH_HOME storage root and every user-supplied workspace
 * directory resolve through this one function, so the two cannot diverge in how
 * they expand ~, $VAR, or %VAR%, and neither can fall through to process.cwd().
 */
function expandAndResolve(input: string, base: string): string {
  let value = input.trim();
  if (value === "~") {
    value = base;
  } else if (value.startsWith("~/") || value.startsWith("~\\")) {
    value = path.join(base, value.slice(2));
  }
  value = value
    .replace(/\$(\w+)/g, (match, name: string) => process.env[name] ?? match)
    .replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match);
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value);
}

/**
 * Resolves the single storage root: BIGMOUTH_HOME when set and non-empty,
 * otherwise ~/.bigmouth. The root is derived from the home-directory API and
 * never from the working directory or the running code's location, so the same
 * root is used however the app is launched. The override is expanded and made
 * absolute against the home directory by the shared pipeline above.
 */
function resolveAppDir(): string {
  const home = os.homedir();
  const override = process.env[HOME_ENV_VAR];
  if (override === undefined || override.trim() === "") {
    return path.join(home, `.${APP_NAME}`);
  }
  return expandAndResolve(override, home);
}

let appConfig: AppConfig | null = null;

function defaultAppConfig(): AppConfig {
  return {
    workspaces: [],
  };
}

function parseAppConfig(raw: unknown): AppConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid app.json: expected an object");
  }

  const source = raw as Record<string, unknown>;
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

  return { workspaces };
}

/**
 * Expands and absolutizes a user-supplied workspace directory through the shared
 * pipeline (see expandAndResolve): a leading ~ / ~/ / ~\, $VAR, and %VAR% are
 * expanded, and a relative value resolves against the home directory — never the
 * working directory, which on a double-clicked or service launch is unrelated to
 * where the user meant the folder to be.
 */
function expandPath(p: string): string {
  return expandAndResolve(p, os.homedir());
}

/**
 * Ensures ~/.bigmouth/ and logs/ exist. Loads or creates app.json.
 * Must be called once at startup.
 */
export function initAppDir(): AppConfig {
  // Resolve the root and its derived paths here (not at import) so BIGMOUTH_HOME
  // is read at a defined startup point with the environment fully known.
  appDir = resolveAppDir();
  appJsonPath = path.join(appDir, "app.json");
  logsDir = path.join(appDir, "logs");
  apiKeysPath = path.join(appDir, "api-keys.json");
  defaultWorkspacesDir = path.join(appDir, "workspaces");

  // Create the root + standard subdirs on first use. If the root cannot be
  // created or is not a usable directory, fail loudly — never silently fall
  // back to the default.
  try {
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    if (!fs.statSync(appDir).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch (cause) {
    throw new Error(
      `Cannot use the ${APP_NAME} storage root "${appDir}". Set ${HOME_ENV_VAR} to a writable directory.`,
      { cause }
    );
  }

  if (fs.existsSync(appJsonPath)) {
    const raw = fs.readFileSync(appJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    appConfig = parseAppConfig(parsed);
  } else {
    appConfig = defaultAppConfig();
    writeAppConfig();
  }

  return appConfig;
}

function writeAppConfig(): void {
  if (!appJsonPath) throw new Error("workspaceStore not initialized — call initAppDir() first");
  writeFileAtomic(appJsonPath, JSON.stringify(appConfig, null, 2) + "\n");
}

function ensureLoaded(): AppConfig {
  if (!appConfig) throw new Error("workspaceStore not initialized — call initAppDir() first");
  return appConfig;
}

export function getLogsDir(): string {
  if (!logsDir) throw new Error("workspaceStore not initialized — call initAppDir() first");
  return logsDir;
}

/** The storage-root secrets file (`~/.bigmouth/api-keys.json`) — outside any workspace. */
export function getApiKeysPath(): string {
  if (!apiKeysPath) throw new Error("workspaceStore not initialized — call initAppDir() first");
  return apiKeysPath;
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

  const requiredDirs = ["posts", "assets"];
  const dirsPresent = requiredDirs.every((entry) => {
    const entryPath = path.join(dir, entry);
    return fs.existsSync(entryPath) && fs.statSync(entryPath).isDirectory();
  });
  if (!dirsPresent) return false;

  // config.json must not merely exist but parse as a BigMouth config (its schema
  // version + sections). A generic blog/static-site folder that happens to have a
  // config.json alongside posts/ and assets/ is NOT a workspace — accepting it
  // would let the first settings save normalize-and-overwrite its unrelated config.
  const configPath = path.join(dir, "config.json");
  if (!fs.existsSync(configPath)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return false;
  }
  return isWorkspaceConfig(parsed);
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
    if (!defaultWorkspacesDir) {
      throw new Error("workspaceStore not initialized — call initAppDir() first");
    }
    dir = path.join(defaultWorkspacesDir, id);
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

  // Validate every change before mutating, so a rejected update leaves the
  // in-memory registry (the same objects listWorkspaces hands the renderer)
  // untouched rather than half-applied and out of sync with what is on disk.
  let nextDir: string | undefined;
  if (updates.dataDirectory !== undefined) {
    nextDir = expandPath(updates.dataDirectory);
    const existing = findWorkspaceByDirectory(nextDir);
    if (existing && existing.id !== id) {
      throw new Error(`That folder is already registered as workspace "${existing.name}".`);
    }
    if (!isEmptyDirectory(nextDir) && !isWorkspaceDirectory(nextDir)) {
      throw new Error("Workspace location must be an empty folder or an existing workspace.");
    }
  }

  if (updates.name !== undefined) ws.name = updates.name;
  if (nextDir !== undefined) ws.dataDirectory = nextDir;

  writeAppConfig();
  return ws;
}

export function deleteWorkspace(id: string): boolean {
  const config = ensureLoaded();
  const index = config.workspaces.findIndex((w) => w.id === id);
  if (index === -1) return false;

  config.workspaces.splice(index, 1);
  writeAppConfig();
  // Drop the workspace's stored API keys too — they live in the shared secrets
  // file keyed by workspace id, so deregistering a workspace must take its keys
  // with it rather than leave them orphaned forever.
  clearWorkspaceKeys(getApiKeysPath(), id);
  forgetWorkspace(id);
  return true;
}
