/**
 * Workspace registry I/O.
 *
 * Manages `workspaces.json` under the storage root: which workspaces exist,
 * where each one lives, and the create/open/update/delete decisions around
 * that. WHERE the app keeps its data is a separate concern with a separate
 * reason to change, and lives in storagePaths.
 */

import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { AppConfig, Workspace } from "../shared/types.js";
import { writeManagedText } from "../shared/atomicWrite.js";
import { isWorkspaceConfig } from "../shared/workspaceConfigShape.js";
import { initializeWorkspaceData } from "./dataDir.js";
import { clearWorkspaceKeys } from "./apiKeys.js";
import { forgetWorkspace } from "./activeConfig.js";
import {
  expandWorkspacePath,
  getApiKeysPath,
  getDefaultWorkspacesDir,
  getWorkspacesJsonPath,
  initStorageRoot,
  sameDirectory,
} from "./storagePaths.js";

let appConfig: AppConfig | null = null;

function defaultAppConfig(): AppConfig {
  return {
    workspaces: [],
  };
}

function parseAppConfig(raw: unknown): AppConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid workspaces.json: expected an object");
  }

  const source = raw as Record<string, unknown>;
  if (!Array.isArray(source.workspaces)) {
    throw new Error("Invalid workspaces.json: workspaces must be an array");
  }

  const workspaces = source.workspaces.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("Invalid workspaces.json: each workspace must be an object");
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.name !== "string" ||
      typeof record.dataDirectory !== "string"
    ) {
      throw new Error("Invalid workspaces.json: each workspace needs id, name, and dataDirectory");
    }
    return {
      id: record.id,
      name: record.name,
      dataDirectory: record.dataDirectory,
    };
  });

  return { workspaces };
}

/** Resolves the storage root, then loads (or materializes) the registry in it. */
export function initAppDir(): AppConfig {
  initStorageRoot();
  const registryPath = getWorkspacesJsonPath();

  if (fs.existsSync(registryPath)) {
    const raw = fs.readFileSync(registryPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    appConfig = parseAppConfig(parsed);
  } else {
    appConfig = defaultAppConfig();
    writeAppConfig();
  }

  return appConfig;
}

function writeAppConfig(): void {
  // recorded: workspaces.json is the durable workspace REGISTRY — the map from workspace id to its
  // on-disk dataDirectory. Losing it strands every externally-linked workspace even when the workspace
  // folders themselves survive, so it is exactly the managed text the backup exists to protect.
  writeManagedText(getWorkspacesJsonPath(), JSON.stringify(appConfig, null, 2) + "\n");
}

function ensureLoaded(): AppConfig {
  if (!appConfig) throw new Error("workspaceStore not initialized — call initAppDir() first");
  return appConfig;
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
  const normalized = expandWorkspacePath(dir);
  return ensureLoaded().workspaces.find((workspace) =>
    sameDirectory(workspace.dataDirectory, normalized),
  );
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
    dir = expandWorkspacePath(dataDirectory);
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
        // The UI has one "Open or Create" control, so there is no "Open" to point at
    // — and openOrCreateWorkspace already routes this case to openWorkspace, so
    // this is reached only by a direct createWorkspace call.
    throw new Error("That folder already contains a workspace.");
      }
      if (!isEmptyDirectory(dir)) {
        throw new Error("New workspaces can only be created in an empty folder.");
      }
    }
  } else {
    dir = path.join(getDefaultWorkspacesDir(), id);
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
  const dir = expandWorkspacePath(dataDirectory);
  const existing = findWorkspaceByDirectory(dir);
  if (existing) {
    return existing;
  }
  if (!isWorkspaceDirectory(dir)) {
    throw new Error("Choose an existing BigMouth workspace folder.");
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

  const dir = expandWorkspacePath(trimmedDir);
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
      throw new Error("Location must be empty or already contain a BigMouth workspace.");
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
    nextDir = expandWorkspacePath(updates.dataDirectory);
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
