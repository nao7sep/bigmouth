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

/**
 * Every message here names the file's path and says it was left in place: a halt
 * is only reasonable when the user can act on it, and `BIGMOUTH_HOME` can put
 * the registry anywhere.
 */
function parseAppConfig(raw: unknown, filePath: string): AppConfig {
  // A function declaration, not an arrow: TypeScript narrows on a `never` return
  // from one, which is what lets the callers below read as plain guards instead
  // of needing an unreachable throw after each.
  function reject(detail: string): never {
    throw new Error(
      `Cannot read the workspace registry at ${filePath}: ${detail}. It was left unchanged.`,
    );
  }

  if (!raw || typeof raw !== "object") reject("it does not contain a JSON object");

  const source = raw as Record<string, unknown>;
  const entries = source.workspaces;
  if (!Array.isArray(entries)) reject("its `workspaces` key is not an array");

  const workspaces = (entries as unknown[]).map((item) => {
    if (!item || typeof item !== "object") reject("one of its workspaces is not an object");
    const { id, name, dataDirectory } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string" || typeof dataDirectory !== "string") {
      reject("one of its workspaces is missing an id, a name, or a dataDirectory");
    }
    return { id, name, dataDirectory };
  });

  return { workspaces };
}

/** Resolves the storage root, then loads (or materializes) the registry in it. */
export function initAppDir(): AppConfig {
  initStorageRoot();
  const registryPath = getWorkspacesJsonPath();

  if (fs.existsSync(registryPath)) {
    const raw = fs.readFileSync(registryPath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      // A halt has to name the store AND its path and say the file was left in
      // place, because halting only makes sense when there is a way back. A bare
      // JSON.parse threw a SyntaxError, which reached the user as a startup
      // dialog reading "Unexpected end of JSON input" — naming neither the file
      // nor where it is, and BIGMOUTH_HOME can put it anywhere.
      throw new Error(
        `Cannot read the workspace registry at ${registryPath}: the file is not valid JSON. It was left unchanged.`,
        { cause },
      );
    }
    appConfig = parseAppConfig(parsed, registryPath);
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

/**
 * Renames a workspace. Only the name — a workspace's folder is where it is.
 *
 * This used to take a `dataDirectory` too, and it re-pointed the registry entry
 * without moving a single file: a relocation that existed in the data model and
 * across IPC but was unreachable from the UI, whose only caller passed a name.
 * It even permitted an EMPTY target, so surfacing it as written would have left
 * every post behind and presented the user an empty workspace. The
 * storage-path conventions call that shape a trap. It is gone rather than
 * finished, because moving a workspace tree is its own feature with its own
 * failure modes, not a field on a rename.
 */
export function updateWorkspace(id: string, updates: { name: string }): Workspace | null {
  const config = ensureLoaded();
  const ws = config.workspaces.find((w) => w.id === id);
  if (!ws) return null;

  ws.name = updates.name;
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
