/**
 * API key storage — the secret store, kept OUT of the git-versionable workspace.
 *
 * Keys live in one file under the app storage root (`~/.bigmouth/api-keys.json`),
 * never inside a workspace a user may point at any folder and commit
 * (storage-path-conventions, "Secrets and keys"). configStore resolves, sets, and
 * clears keys through here; the workspace file persists only non-secret config.
 *
 * Keyed by (workspaceId, configId). A config id travels inside the committed
 * `ai-configs.json`, so two workspaces that share one — a copied folder, a repo
 * cloned and opened twice on one machine — would otherwise collide on a single
 * key. The workspace registry id (machine-local, stable across folder moves,
 * distinct per clone) disambiguates them, and lets a workspace's keys be dropped
 * in one step when it is removed. The key itself is machine-local and re-entered
 * (or supplied via env) wherever the workspace is opened.
 *
 * Contract:
 *   - Resolution is environment-first: the provider's env var (ANTHROPIC_API_KEY)
 *     wins over the stored value and is never written back. Both sources are
 *     trimmed; a blank value counts as no key.
 *   - The stored value is lightly obfuscated (NOT encryption); the real
 *     protection is the file's 0600 mode. On POSIX the file is created 0600, and a
 *     group/world-readable file is tightened on every read (warned once per
 *     process, so a key read on each AI call does not spam the log). Skipped on
 *     Windows, which uses a different permission model.
 *   - A corrupt file, or any non-string entry in it, is treated as absent rather
 *     than allowed to throw — a hand-edited secrets file never bricks AI use.
 */

import fs from "node:fs";

import type { AiProvider } from "../shared/types.js";
import { obfuscate, deobfuscate } from "../shared/obfuscation.js";
import { writeFileAtomic } from "../shared/atomicWrite.js";
import { warn as logWarn } from "./logger.js";

// The environment variable that takes precedence over the stored key, per provider.
const API_KEY_ENV_VAR: Record<AiProvider, string> = {
  claude: "ANTHROPIC_API_KEY",
};

const SECRETS_FILE_MODE = 0o600;
const ENFORCE_FILE_MODE = process.platform !== "win32";

// The secrets file: workspaceId -> configId -> obfuscated key. Nested (not a flat
// composite key) so a workspace's keys read and drop as one unit.
type WorkspaceKeys = Record<string, string>;
interface ApiKeysFile {
  workspaces: Record<string, WorkspaceKeys>;
}

// Warn at most once per process about an insecure file mode, so a key read on
// every AI call does not spam the log. The tightening itself is never suppressed.
let modeWarned = false;

function envApiKey(provider: AiProvider): string | null {
  const value = process.env[API_KEY_ENV_VAR[provider]]?.trim();
  return value ? value : null;
}

// POSIX-only: tighten the file back to 0600 whenever it is readable beyond the
// owner, warning once. Best-effort — a failed stat/chmod never blocks a key read.
function ensureSecureMode(filePath: string): void {
  if (!ENFORCE_FILE_MODE) return;
  let mode: number;
  try {
    mode = fs.statSync(filePath).mode;
  } catch {
    return; // No file yet, or stat failed — nothing to tighten.
  }
  if ((mode & 0o077) === 0) return;
  if (!modeWarned) {
    modeWarned = true;
    logWarn("api-keys.json is readable beyond the owner; tightening to 0600", {
      path: filePath,
      mode: (mode & 0o777).toString(8).padStart(3, "0"),
    });
  }
  try {
    fs.chmodSync(filePath, SECRETS_FILE_MODE);
  } catch {
    // Best-effort: the next write re-applies 0600 anyway.
  }
}

// Read the whole store, tolerating a missing/corrupt file and dropping any entry
// that is not a string, so a hand-edited file degrades to "no key", not a throw.
function readFile(filePath: string): ApiKeysFile {
  ensureSecureMode(filePath);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return { workspaces: {} }; // No file, or corrupt JSON.
  }
  const workspaces: Record<string, WorkspaceKeys> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const rawWorkspaces = (raw as { workspaces?: unknown }).workspaces;
    if (rawWorkspaces && typeof rawWorkspaces === "object" && !Array.isArray(rawWorkspaces)) {
      for (const [wsId, configs] of Object.entries(rawWorkspaces as Record<string, unknown>)) {
        if (!configs || typeof configs !== "object" || Array.isArray(configs)) continue;
        const keys: WorkspaceKeys = {};
        for (const [configId, value] of Object.entries(configs as Record<string, unknown>)) {
          if (typeof value === "string") keys[configId] = value;
        }
        if (Object.keys(keys).length > 0) workspaces[wsId] = keys;
      }
    }
  }
  return { workspaces };
}

function writeFile(filePath: string, data: ApiKeysFile): void {
  writeFileAtomic(
    filePath,
    JSON.stringify(data, null, 2) + "\n",
    ENFORCE_FILE_MODE ? SECRETS_FILE_MODE : undefined,
  );
}

// Apply a mutation and persist only if it changed the stored content, so a no-op
// clear never materializes an empty file. Empty workspace buckets are pruned so a
// cleared workspace leaves no trace.
function update(filePath: string, mutate: (data: ApiKeysFile) => void): void {
  const data = readFile(filePath);
  const before = JSON.stringify(data);
  mutate(data);
  for (const [wsId, keys] of Object.entries(data.workspaces)) {
    if (Object.keys(keys).length === 0) delete data.workspaces[wsId];
  }
  if (JSON.stringify(data) !== before) writeFile(filePath, data);
}

/**
 * Resolve a config's API key, environment-first. Returns the env value when the
 * provider's env var is set (never persisting it), otherwise the stored key, or
 * null when neither resolves to a non-blank value.
 */
export function resolveApiKey(
  filePath: string,
  workspaceId: string,
  configId: string,
  provider: AiProvider,
): string | null {
  const fromEnv = envApiKey(provider);
  if (fromEnv !== null) return fromEnv;
  const stored = readFile(filePath).workspaces[workspaceId]?.[configId];
  const key = stored ? deobfuscate(stored).trim() : "";
  return key.length > 0 ? key : null;
}

/**
 * The config ids that have their own stored key in this workspace. Lets the
 * renderer-facing per-config "key is stored" flag be built with a single read;
 * the environment is deliberately excluded so the flag reflects only what is
 * stored for that specific config.
 */
export function readStoredConfigIds(filePath: string, workspaceId: string): Set<string> {
  const keys = readFile(filePath).workspaces[workspaceId];
  if (!keys) return new Set();
  return new Set(
    Object.entries(keys)
      .filter(([, value]) => deobfuscate(value).trim().length > 0)
      .map(([configId]) => configId),
  );
}

/** Whether the provider's env var is set, and therefore overrides any stored key. */
export function hasEnvApiKey(provider: AiProvider): boolean {
  return envApiKey(provider) !== null;
}

/** Store (obfuscated) or, for a blank key, remove the config's key. */
export function writeApiKey(filePath: string, workspaceId: string, configId: string, key: string): void {
  const trimmed = key.trim();
  update(filePath, (data) => {
    if (trimmed.length > 0) {
      (data.workspaces[workspaceId] ??= {})[configId] = obfuscate(trimmed);
    } else {
      delete data.workspaces[workspaceId]?.[configId];
    }
  });
}

/** Remove the config's stored key. The environment value, if any, is unaffected. */
export function clearApiKey(filePath: string, workspaceId: string, configId: string): void {
  update(filePath, (data) => {
    delete data.workspaces[workspaceId]?.[configId];
  });
}

/** Remove every stored key for a workspace — used when the workspace is deleted. */
export function clearWorkspaceKeys(filePath: string, workspaceId: string): void {
  update(filePath, (data) => {
    delete data.workspaces[workspaceId];
  });
}
