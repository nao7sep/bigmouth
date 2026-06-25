/**
 * API key storage — the secret store, kept OUT of the git-versionable workspace.
 *
 * Per the storage-path-conventions' "Secrets and keys" rule (and mirroring the
 * other AI tools' `api-keys.json`), keys live in their own file under the app
 * storage root (`~/.bigmouth/api-keys.json`), never inside a workspace that a
 * user may point at any folder and commit. The file is the single reader/writer
 * of the secret; `configStore` resolves, sets, and clears keys through here and
 * persists only non-secret config (provider/model) in the workspace.
 *
 * Each key is keyed by its AI config's nanoid id, so multiple named configs each
 * keep their own key and a workspace stays portable: the config travels in the
 * committed file, the key is machine-local and re-entered (or supplied via env)
 * wherever the workspace is opened.
 *
 * Contract:
 *   - Resolution is environment-first: the provider's env var (ANTHROPIC_API_KEY)
 *     wins over the stored value and is never written back.
 *   - The stored value is lightly obfuscated (NOT encryption); the real
 *     protection is the file's 0600 mode. On POSIX the file is written 0600, and
 *     a group/world-readable file is warned about once and tightened on read,
 *     never refused. The check is skipped on Windows (different permission model).
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

// The secrets file: config id -> obfuscated key. A record (not a flat field) so
// any number of configs coexist without changing the file shape.
interface ApiKeysFile {
  keys: Record<string, string>;
}

// Warn at most once per process about an insecure file mode, so a key read on
// every AI call does not spam the log.
let modeWarned = false;

function envApiKey(provider: AiProvider): string | null {
  const value = process.env[API_KEY_ENV_VAR[provider]];
  return value && value.trim() !== "" ? value.trim() : null;
}

// POSIX-only: warn once if the file is readable beyond the owner and tighten it
// back to 0600. Best-effort — a failed stat/chmod never blocks reading a key.
function warnIfInsecureMode(filePath: string): void {
  if (!ENFORCE_FILE_MODE || modeWarned) return;
  try {
    const fileStat = fs.statSync(filePath);
    if ((fileStat.mode & 0o077) !== 0) {
      modeWarned = true;
      logWarn("api-keys.json is readable beyond the owner; tightening to 0600", {
        path: filePath,
        mode: (fileStat.mode & 0o777).toString(8).padStart(3, "0"),
      });
      try {
        fs.chmodSync(filePath, SECRETS_FILE_MODE);
      } catch {
        // Best-effort: the next write re-applies 0600 anyway.
      }
    }
  } catch {
    // No file yet, or stat failed — nothing to warn about.
  }
}

function readAll(filePath: string): ApiKeysFile {
  warnIfInsecureMode(filePath);
  if (!fs.existsSync(filePath)) return { keys: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const keys = (raw as { keys?: unknown }).keys;
      if (keys && typeof keys === "object" && !Array.isArray(keys)) {
        return { keys: keys as Record<string, string> };
      }
    }
  } catch {
    // Corrupt secrets file — treat as empty rather than bricking AI use.
  }
  return { keys: {} };
}

function writeAll(filePath: string, data: ApiKeysFile): void {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2) + "\n", ENFORCE_FILE_MODE ? SECRETS_FILE_MODE : undefined);
}

/**
 * Resolve a config's API key, environment-first. Returns the env value when the
 * provider's env var is set (never persisting it), otherwise the stored key, or
 * null when neither is present.
 */
export function resolveApiKey(filePath: string, configId: string, provider: AiProvider): string | null {
  const fromEnv = envApiKey(provider);
  if (fromEnv !== null) return fromEnv;
  const stored = readAll(filePath).keys[configId] ?? "";
  const key = stored ? deobfuscate(stored) : "";
  return key.length > 0 ? key : null;
}

/** Whether a key is available for the config from either the environment or the file. */
export function hasApiKey(filePath: string, configId: string, provider: AiProvider): boolean {
  return resolveApiKey(filePath, configId, provider) !== null;
}

/** Store (obfuscated) or, for an empty key, remove the config's key. Writes 0600. */
export function writeApiKey(filePath: string, configId: string, key: string): void {
  const all = readAll(filePath);
  if (key.length > 0) all.keys[configId] = obfuscate(key);
  else delete all.keys[configId];
  writeAll(filePath, all);
}

/** Remove the config's stored key. The environment value, if any, is unaffected. */
export function clearApiKey(filePath: string, configId: string): void {
  const all = readAll(filePath);
  if (all.keys[configId] === undefined) return;
  delete all.keys[configId];
  writeAll(filePath, all);
}
