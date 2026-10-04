/**
 * API key storage and resolution — the secret store at `~/.bigmouth/api-keys.json`,
 * kept OUT of the git-versionable workspace. This is the fleet
 * api-key-storage-conventions realized for bigmouth's scoped key identity.
 *
 * A key belongs to a workspace, because each workspace is billed on its own
 * account; the machine-local workspace id is opaque (nanoid: mixed case,
 * `_`/`-`), so it lives in the container path and the key id is the provider:
 *
 *   { "workspaces": { "<wsId>": { "keys": { "anthropic": "obf:…" } } } }
 *
 * Contract (api-key-storage-conventions):
 *   - The key id is the provider; its environment variable is the id
 *     uppercased + "_API_KEY" (anthropic → ANTHROPIC_API_KEY), derived with no
 *     mapping table because the provider id IS the conventional name.
 *   - Resolution prefers the environment (scope-independent, provider-level): the
 *     env value wins over the stored value and is never written back. Both are
 *     trimmed; a blank value counts as no key.
 *   - The stored value is lightly obfuscated (NOT encryption); the real
 *     protection is the file's 0600 mode. On POSIX the file is created 0600 and a
 *     group/world-readable file is tightened on read (warned once per process).
 *   - A corrupt/unreadable file is moved aside to a timestamped neighbour and
 *     treated as empty rather than throwing; a non-string or non-conforming entry
 *     is ignored, so a hand-edited file never bricks key resolution.
 *   - A stored value whose `obf:` payload fails strict base64 validation (a
 *     hand-edited or truncated file) resolves as absent rather than the
 *     garbage a tolerant base64 decoder would silently produce; resolveApiKey
 *     warns once, naming the key, when this happens.
 */

import fs from "node:fs";

import type { AiProvider } from "@shared/aiModels";
import { obfuscate, deobfuscate } from "../shared/obfuscation.js";
import { writeFileAtomic } from "../shared/atomicWrite.js";
import { moveAsideInvalid } from "../shared/quarantine.js";
import { serializeError, warn as logWarn } from "./logger.js";

const SECRETS_FILE_MODE = 0o600;
const ENFORCE_FILE_MODE = process.platform !== "win32";
const KEY_ID_RE = /^[a-z0-9]+(\.[a-z0-9]+)*$/;

// The secrets file: workspaceId -> keys -> key id -> value, so a workspace's
// keys read and drop as one unit.
interface WorkspaceKeys {
  keys: Record<string, string>;
}
interface ApiKeysFile {
  workspaces: Record<string, WorkspaceKeys>;
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

// Validate and canonicalize the on-disk tree, dropping anything that is not the
// expected shape: workspace -> keys -> { <key id>: string }.
function normalize(raw: unknown): ApiKeysFile | null {
  const out: ApiKeysFile = { workspaces: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const workspaces = (raw as { workspaces?: unknown }).workspaces;
  if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) return null;
  for (const [wsId, wsNode] of Object.entries(workspaces as Record<string, unknown>)) {
    if (!wsNode || typeof wsNode !== "object" || Array.isArray(wsNode)) return null;
    const keys = (wsNode as { keys?: unknown }).keys;
    if (!keys || typeof keys !== "object" || Array.isArray(keys)) return null;
    const outKeys: Record<string, string> = {};
    for (const [id, value] of Object.entries(keys as Record<string, unknown>)) {
      const canonical = id.toLowerCase();
      if (typeof value === "string" && KEY_ID_RE.test(canonical)) outKeys[canonical] = value;
    }
    if (Object.keys(outKeys).length > 0) out.workspaces[wsId] = { keys: outKeys };
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
      error: serializeError(err),
    });
    return { workspaces: {} };
  }
  try {
    const normalized = normalize(JSON.parse(text));
    if (normalized) return normalized;
    const movedTo = moveAsideInvalid(filePath);
    logWarn("api-keys.json had the wrong shape; set aside and treating as empty", {
      path: filePath,
      movedTo,
    });
    return { workspaces: {} };
  } catch (err) {
    const movedTo = moveAsideInvalid(filePath);
    logWarn("api-keys.json was not valid JSON; set aside and treating as empty", {
      path: filePath,
      movedTo,
      error: serializeError(err),
    });
    return { workspaces: {} };
  }
}

function writeFile(filePath: string, data: ApiKeysFile): void {
  // not recorded: api-keys.json is the SECRET store. Secrets are never written through the managed-text
  // choke point — a backup history containing a credential would become sensitive-at-rest in its
  // entirety and would have to be guarded as the secret is. Keeping keys out is what lets
  // backups.sqlite3 stay no more sensitive than ordinary user text (data-backup conventions: secrets are
  // never recorded). A key lost to a wipe is re-entered by the user; the live file keeps its own 0600
  // protection below, which is where a secret is guarded — not here.
  writeFileAtomic(
    filePath,
    JSON.stringify(data, null, 2) + "\n",
    ENFORCE_FILE_MODE ? SECRETS_FILE_MODE : undefined,
  );
}

// Apply a mutation and persist only if it changed the stored content, pruning
// emptied workspace buckets so a cleared scope leaves no trace.
function update(filePath: string, mutate: (data: ApiKeysFile) => void): void {
  const data = readFile(filePath);
  const before = JSON.stringify(data);
  mutate(data);
  for (const [wsId, wsNode] of Object.entries(data.workspaces)) {
    if (Object.keys(wsNode.keys).length === 0) delete data.workspaces[wsId];
  }
  if (JSON.stringify(data) !== before) writeFile(filePath, data);
}

/** The stored key for a workspace, decoded and trimmed, or null. */
function storedKey(filePath: string, workspaceId: string, provider: AiProvider): string | null {
  const stored = readFile(filePath).workspaces[workspaceId]?.keys[provider];
  if (!stored) return null;
  const decoded = deobfuscate(stored);
  if (decoded === null) {
    // Malformed obf: payload (fails strict base64 validation) — resolve as
    // absent rather than send Buffer.from's tolerant-decode garbage to the
    // provider as a key, per the api-key-storage-conventions. Warn here,
    // naming the key, since (unlike a genuinely empty value) this is a data
    // problem worth surfacing.
    logWarn("stored API key has an invalid obf: encoding; treating as absent", { workspaceId, key: provider });
    return null;
  }
  const key = decoded.trim();
  return key.length > 0 ? key : null;
}

/**
 * Resolve a workspace's key for a provider, environment-first. The env var is
 * provider-level (`ANTHROPIC_API_KEY`) and overrides every workspace; otherwise
 * the workspace's stored key is used, or null when neither resolves.
 */
export function resolveApiKey(filePath: string, workspaceId: string, provider: AiProvider): string | null {
  return envApiKey(provider) ?? storedKey(filePath, workspaceId, provider);
}

/**
 * Whether the workspace has its own stored key for the provider. The environment
 * is deliberately excluded so the renderer's "key is stored" flag reflects only
 * what is stored.
 */
export function hasStoredApiKey(filePath: string, workspaceId: string, provider: AiProvider): boolean {
  return storedKey(filePath, workspaceId, provider) !== null;
}

/** Whether the provider's env var is set, and therefore overrides any stored key. */
export function hasEnvApiKey(provider: AiProvider): boolean {
  return envApiKey(provider) !== null;
}

/** Store (obfuscated, trimmed) or, for a blank key, remove the workspace's key. */
export function writeApiKey(filePath: string, workspaceId: string, provider: AiProvider, key: string): void {
  const trimmed = key.trim();
  update(filePath, (data) => {
    if (trimmed.length > 0) {
      const ws = (data.workspaces[workspaceId] ??= { keys: {} });
      ws.keys[provider] = obfuscate(trimmed);
    } else {
      const ws = data.workspaces[workspaceId];
      if (ws) delete ws.keys[provider];
    }
  });
}

/** Remove every stored key for a workspace — used when the workspace is deleted. */
export function clearWorkspaceKeys(filePath: string, workspaceId: string): void {
  update(filePath, (data) => {
    delete data.workspaces[workspaceId];
  });
}
