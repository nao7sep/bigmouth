/**
 * API key storage and resolution — the secret store at `~/.bigmouth/api-keys.json`,
 * kept OUT of the git-versionable workspace. This is the fleet
 * api-key-storage-conventions realized for bigmouth's scoped key identity.
 *
 * A key belongs to a workspace, because each workspace is billed on its own
 * account; the machine-local workspace id is opaque (nanoid: mixed case,
 * `_`/`-`), so it lives in the container path and the key id is the provider:
 *
 *   { "formatVersion": 1, "workspaces": { "<wsId>": { "keys": { "anthropic": "obf:…" } } } }
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
 *   - A lookup never moves or rewrites the file. A file whose content is
 *     damaged reads as holding no key; saving a key then moves it aside to a
 *     timestamped neighbour and starts a new file, so other workspaces' keys
 *     are entered again (developer decision). A file that could not be read at
 *     all, or that a newer version of BigMouth wrote, also reads as holding no
 *     key, and storing a key into it is refused.
 *   - A workspace entry, key id or value that is not the expected shape is
 *     ignored for lookups and kept as it is when another workspace's key is
 *     written, so a hand-edited entry never takes the other keys with it.
 *   - A stored value whose `obf:` payload fails strict base64 validation (a
 *     hand-edited or truncated file) resolves as absent rather than the
 *     garbage a tolerant base64 decoder would silently produce; resolveApiKey
 *     warns once, naming the key, when this happens.
 */

import fs from "node:fs";

import type { AiProvider } from "@shared/aiModels";
import { obfuscate, deobfuscate } from "../shared/obfuscation.js";
import { writeFileAtomic } from "../shared/atomicWrite.js";
import { message, type Message } from "@shared/i18n/translate";
import { moveAsideInvalid } from "../shared/quarantine.js";
import { FORMAT_VERSION_KEY, NewerFormatError, UnreadableStoreError, jsonStoreText, readJsonStore } from "../shared/storeFormat.js";
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

// The usable keys in the file: workspace -> keys -> { <key id>: string }. A
// workspace entry, key id or value of another shape is skipped, not fatal.
function usableKeys(raw: Record<string, unknown>): ApiKeysFile {
  const out: ApiKeysFile = { workspaces: {} };
  for (const [wsId, wsNode] of Object.entries(raw.workspaces as Record<string, unknown>)) {
    if (!isObject(wsNode) || !isObject(wsNode.keys)) continue;
    const outKeys: Record<string, string> = {};
    for (const [id, value] of Object.entries(wsNode.keys)) {
      const canonical = id.toLowerCase();
      if (typeof value === "string" && KEY_ID_RE.test(canonical)) outKeys[canonical] = value;
    }
    if (Object.keys(outKeys).length > 0) out.workspaces[wsId] = { keys: outKeys };
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The file as one load decides it. `raw` is its parsed content, kept so a write
 * changes only the workspace it is about. `damaged` is content this build cannot
 * use, which a key save may set aside; `refusal` is why no write may touch the
 * file at all (a newer version wrote it, or it could not be read).
 */
type KeysRead = {
  raw: Record<string, unknown>;
  keys: ApiKeysFile;
  damaged: { detail: string; error: unknown } | null;
  refusal: NewerFormatError | UnreadableStoreError | null;
};

function readFile(filePath: string): KeysRead {
  const empty = (): Pick<KeysRead, "raw" | "keys"> => ({ raw: { workspaces: {} }, keys: { workspaces: {} } });
  const read = readJsonStore("apiKeys", filePath);
  switch (read.kind) {
    case "absent":
      return { ...empty(), damaged: null, refusal: null };
    case "newer":
      warnOnce("newer", "api-keys.json was written by a newer version of BigMouth; left unchanged, its keys read as absent", {
        path: filePath,
        formatVersion: read.version,
      });
      return { ...empty(), damaged: null, refusal: new NewerFormatError(filePath, read.version) };
    case "inaccessible":
      warnOnce("inaccessible", "api-keys.json could not be read; left unchanged, its keys read as absent", {
        path: filePath,
        detail: read.detail,
        error: serializeError(read.error),
      });
      return { ...empty(), damaged: null, refusal: new UnreadableStoreError(filePath, read.detail, read.error) };
    case "unreadable":
      warnOnce("damaged", "api-keys.json is damaged; left unchanged, its keys read as absent", {
        path: filePath,
        detail: read.detail,
        ...(read.error ? { error: serializeError(read.error) } : {}),
      });
      return { ...empty(), damaged: { detail: read.detail, error: read.error }, refusal: null };
    case "read": {
      if (!isObject(read.value.workspaces)) {
        warnOnce("damaged", "api-keys.json is damaged; left unchanged, its keys read as absent", {
          path: filePath,
          detail: "its workspaces key is not an object",
        });
        return { ...empty(), damaged: { detail: "its workspaces key is not an object", error: null }, refusal: null };
      }
      ensureSecureMode(filePath);
      return { raw: read.value, keys: usableKeys(read.value), damaged: null, refusal: null };
    }
  }
}

// A file in one of these states is read on every key lookup; each is reported once.
const warned = new Set<string>();
function warnOnce(state: string, text: string, fields: Record<string, unknown>): void {
  if (warned.has(state)) return;
  warned.add(state);
  logWarn(text, fields);
}

function writeFile(filePath: string, raw: Record<string, unknown>): void {
  // not recorded: api-keys.json is the SECRET store. Secrets are never written through the managed-text
  // choke point — a backup history containing a credential would become sensitive-at-rest in its
  // entirety and would have to be guarded as the secret is. Keeping keys out is what lets
  // backups.sqlite3 stay no more sensitive than ordinary user text (data-backup conventions: secrets are
  // never recorded). A key lost to a wipe is re-entered by the user; the live file keeps its own 0600
  // protection below, which is where a secret is guarded — not here.
  const body = { ...raw };
  delete body[FORMAT_VERSION_KEY];
  writeFileAtomic(
    filePath,
    jsonStoreText("apiKeys", body),
    ENFORCE_FILE_MODE ? SECRETS_FILE_MODE : undefined,
  );
}

/**
 * Changes one workspace's keys and persists only if that changed the file,
 * dropping an emptied workspace so a cleared scope leaves no trace. Every other
 * entry is written back as it was read. A file that must not be written is
 * refused before anything changes. A damaged file is set aside first, and the
 * path it went to is returned.
 */
function update(filePath: string, workspaceId: string, mutate: (keys: Record<string, string>) => void): string | null {
  const read = readFile(filePath);
  if (read.refusal) throw read.refusal;
  const workspaces = read.raw.workspaces as Record<string, unknown>;
  const keys = { ...(read.keys.workspaces[workspaceId]?.keys ?? {}) };
  const before = JSON.stringify(keys);
  mutate(keys);
  if (JSON.stringify(keys) === before) return null;
  let movedTo: string | null = null;
  if (read.damaged) {
    // A failed move throws, so the damaged bytes are never written over.
    movedTo = moveAsideInvalid(filePath);
    logWarn("api-keys.json was damaged; set aside to save a key, starting a new file", {
      path: filePath,
      movedTo,
      detail: read.damaged.detail,
    });
    warned.delete("damaged");
  }
  const next = { ...workspaces };
  if (Object.keys(keys).length > 0) next[workspaceId] = { keys };
  else delete next[workspaceId];
  writeFile(filePath, { ...read.raw, workspaces: next });
  return movedTo;
}

/** What the user should be told about the key file, or null when it can be used. */
export function keyFileProblem(filePath: string): Message | null {
  const read = readFile(filePath);
  if (read.refusal instanceof NewerFormatError) return message("store.newerFormat", { path: filePath });
  if (read.refusal) return message("settings.keyFileInaccessible", { path: filePath });
  if (read.damaged) return message("settings.keyFileDamaged", { path: filePath });
  return null;
}

/** The stored key for a workspace, decoded and trimmed, or null. */
function storedKey(filePath: string, workspaceId: string, provider: AiProvider): string | null {
  const stored = readFile(filePath).keys.workspaces[workspaceId]?.keys[provider];
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

/**
 * Store (obfuscated, trimmed) or, for a blank key, remove the workspace's key.
 * Returns where a damaged key file was moved to make room, or null.
 */
export function writeApiKey(filePath: string, workspaceId: string, provider: AiProvider, key: string): string | null {
  const trimmed = key.trim();
  return update(filePath, workspaceId, (keys) => {
    if (trimmed.length > 0) keys[provider] = obfuscate(trimmed);
    else delete keys[provider];
  });
}

/**
 * Remove every stored key for a workspace — used when the workspace is deleted.
 * A file that cannot be written, or whose content is damaged, is left as it is,
 * its key with it, rather than failing the deletion or setting the file aside.
 */
export function clearWorkspaceKeys(filePath: string, workspaceId: string): void {
  const read = readFile(filePath);
  if (read.refusal || read.damaged) return;
  update(filePath, workspaceId, (keys) => {
    for (const id of Object.keys(keys)) delete keys[id];
  });
}
