/**
 * API key storage and resolution — the secret store at `~/.bigmouth/api-keys.json`,
 * kept OUT of the git-versionable workspace. This is the fleet
 * api-key-storage-conventions realized for bigmouth's scoped key identity.
 *
 * A key belongs to a (workspaceId, configId) pair, because a config id travels
 * inside the committed `config.json` and the machine-local workspace id
 * disambiguates two clones. Those ids are opaque (nanoid: mixed case, `_`/`-`),
 * so they are NOT segments — they live in the container path, which the
 * convention reserves for exactly this. The provider is segment 0:
 *
 *   { "workspaces": { "<wsId>": { "configs": { "<cfgId>": { "keys": { "anthropic": "obf:…" } } } } } }
 *
 * Contract (api-key-storage-conventions):
 *   - The key id is the provider segment; its environment variable is the
 *     segment uppercased + "_API_KEY" (anthropic → ANTHROPIC_API_KEY), derived
 *     with no mapping table because the provider id IS the conventional name.
 *   - Resolution prefers the environment (scope-independent, provider-level): the
 *     env value wins over the stored value and is never written back. Both are
 *     trimmed; a blank value counts as no key.
 *   - The stored value is lightly obfuscated (NOT encryption); the real
 *     protection is the file's 0600 mode. On POSIX the file is created 0600 and a
 *     group/world-readable file is tightened on read (warned once per process).
 *   - A corrupt/unreadable file is moved aside to a timestamped neighbour and
 *     treated as empty rather than throwing; a non-string or non-conforming entry
 *     is ignored, so a hand-edited file never bricks key resolution.
 */

import fs from "node:fs";
import path from "node:path";

import type { AiProvider } from "../shared/types.js";
import { obfuscate, deobfuscate } from "../shared/obfuscation.js";
import { writeFileAtomic } from "../shared/atomicWrite.js";
import { utcNow, formatForFilenameMs } from "../shared/timestamps.js";
import { warn as logWarn } from "./logger.js";

const SECRETS_FILE_MODE = 0o600;
const ENFORCE_FILE_MODE = process.platform !== "win32";
const SEGMENT_RE = /^[a-z0-9]+$/;

// The secrets file: workspaceId -> configs -> configId -> keys -> segment -> value.
// Nested so a workspace's keys read and drop as one unit, and a config's keys sit
// behind a `keys` node that can hold future per-config metadata siblings.
interface ConfigKeys {
  keys: Record<string, string>;
}
interface ApiKeysFile {
  workspaces: Record<string, { configs: Record<string, ConfigKeys> }>;
}

// Warn at most once per process about an insecure file mode, so a key read on
// every AI call does not spam the log. The tightening itself is never suppressed.
let modeWarned = false;

function apiKeyEnvVar(provider: AiProvider): string {
  return `${provider.toUpperCase()}_API_KEY`;
}

function envApiKey(provider: AiProvider): string | null {
  const value = process.env[apiKeyEnvVar(provider)]?.trim();
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

// Move the unreadable file aside to a timestamped neighbour (handled once, not
// re-flagged on every read), returning the new path or null on failure. The
// quarantine name follows the derived-filename grammar: `<stem>-<millisecond
// UTC stamp>.invalid`, never the target's full filename with `.invalid`
// dot-appended.
function moveAsideInvalid(filePath: string): string | null {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);
  const movedTo = path.join(dir, `${stem}-${formatForFilenameMs(utcNow())}.invalid`);
  try {
    fs.renameSync(filePath, movedTo);
    return movedTo;
  } catch {
    return null;
  }
}

// Validate and canonicalize the on-disk tree, dropping anything that is not the
// expected shape: workspace -> configs -> config -> keys -> { <segment>: string }.
function normalize(raw: unknown): ApiKeysFile {
  const out: ApiKeysFile = { workspaces: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const workspaces = (raw as { workspaces?: unknown }).workspaces;
  if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) return out;
  for (const [wsId, wsNode] of Object.entries(workspaces as Record<string, unknown>)) {
    if (!wsNode || typeof wsNode !== "object" || Array.isArray(wsNode)) continue;
    const configs = (wsNode as { configs?: unknown }).configs;
    if (!configs || typeof configs !== "object" || Array.isArray(configs)) continue;
    const outConfigs: Record<string, ConfigKeys> = {};
    for (const [cfgId, cfgNode] of Object.entries(configs as Record<string, unknown>)) {
      if (!cfgNode || typeof cfgNode !== "object" || Array.isArray(cfgNode)) continue;
      const keys = (cfgNode as { keys?: unknown }).keys;
      if (!keys || typeof keys !== "object" || Array.isArray(keys)) continue;
      const outKeys: Record<string, string> = {};
      for (const [seg, value] of Object.entries(keys as Record<string, unknown>)) {
        const canonical = seg.toLowerCase();
        if (typeof value === "string" && SEGMENT_RE.test(canonical)) outKeys[canonical] = value;
      }
      if (Object.keys(outKeys).length > 0) outConfigs[cfgId] = { keys: outKeys };
    }
    if (Object.keys(outConfigs).length > 0) out.workspaces[wsId] = { configs: outConfigs };
  }
  return out;
}

function readFile(filePath: string): ApiKeysFile {
  ensureSecureMode(filePath);
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { workspaces: {} };
    const movedTo = moveAsideInvalid(filePath);
    logWarn("api-keys.json was unreadable; set aside and treating as empty", {
      path: filePath,
      movedTo,
      error: (err as Error).message,
    });
    return { workspaces: {} };
  }
  try {
    return normalize(JSON.parse(text));
  } catch (err) {
    const movedTo = moveAsideInvalid(filePath);
    logWarn("api-keys.json was not valid JSON; set aside and treating as empty", {
      path: filePath,
      movedTo,
      error: (err as Error).message,
    });
    return { workspaces: {} };
  }
}

function writeFile(filePath: string, data: ApiKeysFile): void {
  writeFileAtomic(
    filePath,
    JSON.stringify(data, null, 2) + "\n",
    ENFORCE_FILE_MODE ? SECRETS_FILE_MODE : undefined,
  );
}

// Apply a mutation and persist only if it changed the stored content, pruning
// emptied config and workspace buckets so a cleared scope leaves no trace.
function update(filePath: string, mutate: (data: ApiKeysFile) => void): void {
  const data = readFile(filePath);
  const before = JSON.stringify(data);
  mutate(data);
  for (const [wsId, wsNode] of Object.entries(data.workspaces)) {
    for (const [cfgId, cfgNode] of Object.entries(wsNode.configs)) {
      if (Object.keys(cfgNode.keys).length === 0) delete wsNode.configs[cfgId];
    }
    if (Object.keys(wsNode.configs).length === 0) delete data.workspaces[wsId];
  }
  if (JSON.stringify(data) !== before) writeFile(filePath, data);
}

/**
 * Resolve a config's API key, environment-first. The env var is provider-level
 * (`ANTHROPIC_API_KEY`) and overrides every workspace/config; otherwise the
 * stored key for this (workspace, config) is used, or null when neither resolves.
 */
export function resolveApiKey(
  filePath: string,
  workspaceId: string,
  configId: string,
  provider: AiProvider,
): string | null {
  const fromEnv = envApiKey(provider);
  if (fromEnv !== null) return fromEnv;
  const stored = readFile(filePath).workspaces[workspaceId]?.configs[configId]?.keys[provider];
  const key = stored ? deobfuscate(stored).trim() : "";
  return key.length > 0 ? key : null;
}

/**
 * The config ids in a workspace that have their own stored key (any non-empty
 * key in the config's `keys`). The environment is deliberately excluded so the
 * renderer's per-config "key is stored" flag reflects only what is stored.
 */
export function readStoredConfigIds(filePath: string, workspaceId: string): Set<string> {
  const configs = readFile(filePath).workspaces[workspaceId]?.configs;
  if (!configs) return new Set();
  return new Set(
    Object.entries(configs)
      .filter(([, cfgNode]) => Object.values(cfgNode.keys).some((v) => deobfuscate(v).trim().length > 0))
      .map(([cfgId]) => cfgId),
  );
}

/** Whether the provider's env var is set, and therefore overrides any stored key. */
export function hasEnvApiKey(provider: AiProvider): boolean {
  return envApiKey(provider) !== null;
}

/** Store (obfuscated, trimmed) or, for a blank key, remove the config's key. */
export function writeApiKey(
  filePath: string,
  workspaceId: string,
  configId: string,
  provider: AiProvider,
  key: string,
): void {
  const trimmed = key.trim();
  update(filePath, (data) => {
    if (trimmed.length > 0) {
      const ws = (data.workspaces[workspaceId] ??= { configs: {} });
      const cfg = (ws.configs[configId] ??= { keys: {} });
      cfg.keys[provider] = obfuscate(trimmed);
    } else {
      const cfg = data.workspaces[workspaceId]?.configs[configId];
      if (cfg) delete cfg.keys[provider];
    }
  });
}

/** Remove a config's stored key entirely. The environment value is unaffected. */
export function clearApiKey(filePath: string, workspaceId: string, configId: string): void {
  update(filePath, (data) => {
    const ws = data.workspaces[workspaceId];
    if (ws) delete ws.configs[configId];
  });
}

/** Remove every stored key for a workspace — used when the workspace is deleted. */
export function clearWorkspaceKeys(filePath: string, workspaceId: string): void {
  update(filePath, (data) => {
    delete data.workspaces[workspaceId];
  });
}
