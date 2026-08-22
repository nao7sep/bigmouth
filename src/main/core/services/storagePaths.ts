/**
 * The single storage root, and every standard path derived from it.
 *
 * Split out of the workspace registry, which owned two jobs with different
 * reasons to change: where the app keeps its data, and which workspaces exist.
 * They were touched by disjoint sets of methods and consumed by disjoint sets of
 * modules — the log path, the secrets path and the backup store want the root
 * and nothing else; the asset protocol and the IPC context want the registry and
 * nothing else. A test file for this module already existed before the module
 * did (tests/main/services/storagePaths.test.ts).
 *
 * Splitting it also broke a three-module import cycle: core/shared/atomicWrite
 * reached into core/services/backupStore, which reached into the registry for
 * the root, which reached back into atomicWrite. The cycle survived only
 * because ESM hoists function declarations — anything that turned the backup
 * recorder into a module-init-time value would have deadlocked at import. This
 * module imports nothing but node built-ins.
 *
 * The convention this serves: ONE resolver owns the home-directory call, the
 * `BIGMOUTH_HOME` check, and the names of all standard subpaths — so two
 * derivations of the same file can never drift.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const APP_NAME = "bigmouth";
const HOME_ENV_VAR = "BIGMOUTH_HOME";

// Resolved once, lazily, in initStorageRoot() rather than frozen at import time
// — so a BIGMOUTH_HOME set just before startup (e.g. by a test) is honored, and
// the resolver never captures a half-set environment.
let appDir: string | null = null;
let workspacesJsonPath: string | null = null;
let logsDir: string | null = null;
let apiKeysPath: string | null = null;
let defaultWorkspacesDir: string | null = null;

/**
 * Expands `$VAR` / `%VAR%` environment references against the current
 * environment. An unset (or empty-string) reference expands to nothing,
 * matching shell behavior, rather than being left as a literal `$VAR` that
 * would otherwise become a path segment — this is what lets expandAndResolve
 * detect the collapsed-to-empty case below instead of silently threading a
 * literal `$VAR` into a directory name.
 */
function expandEnvReferences(value: string): string {
  return value
    .replace(/\$(\w+)/g, (_match, name: string) => process.env[name] ?? "")
    .replace(/%([^%]+)%/g, (_match, name: string) => process.env[name] ?? "");
}

/**
 * The storage-root expansion pipeline. Expands a leading ~ / ~/ / ~\ to `base`,
 * substitutes $VAR / %VAR% environment references, and resolves the result to
 * an absolute path against `base` — never against the working directory.
 *
 * An input whose env references leave it expanding to nothing (an unset or
 * empty-string $VAR/%VAR%) is a hard error, never a silent fallback: without
 * this guard, path.resolve(base, "") collapses onto the bare `base` directory,
 * which for BIGMOUTH_HOME would materialize workspaces.json, logs/, and the
 * backups.sqlite3 store directly in $HOME. `label` names the setting that
 * was being expanded (e.g. "BIGMOUTH_HOME") in the thrown message.
 */
function expandAndResolve(input: string, base: string, label: string): string {
  let value = input.trim();
  if (value === "~") {
    value = base;
  } else if (value.startsWith("~/") || value.startsWith("~\\")) {
    value = path.join(base, value.slice(2));
  }
  value = expandEnvReferences(value).trim();

  if (value.length === 0) {
    throw new Error(
      `${label} is set to "${input}" but expands to an empty path (an unset or empty $VAR/%VAR%?). ` +
        "Set it to a usable directory.",
    );
  }

  // path.resolve rather than path.normalize: normalize keeps a trailing
  // separator, and the registry compares dataDirectory as a plain string, so
  // "…/blog" and "…/blog/" registered the same folder twice.
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value);
}

/**
 * Whether two paths name the same folder.
 *
 * String equality is not enough, and the registry used to rely on it: macOS
 * hands back NFD from a file dialog where the user typed NFC, its default volume
 * is case-insensitive, and either can be reached through a symlink. Each of
 * those slipped past the "already registered as workspace X" guard and
 * registered ONE folder twice — two ids, two in-memory indexes keyed by
 * different strings writing over a single posts/index.json, and two separate
 * API-key sets for one workspace.
 */
export function sameDirectory(a: string, b: string): boolean {
  if (a.normalize("NFC") === b.normalize("NFC")) return true;
  try {
    // The filesystem's own answer folds case on a case-insensitive volume and
    // resolves symlinks; no amount of string work can do either. A path that
    // does not exist cannot be a folder already registered, so a throw here is
    // simply "not the same".
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return false;
  }
}

/**
 * Canonicalizes as much of a path as currently exists, then reattaches any
 * missing tail. This lets containment checks resolve symlinks without requiring
 * a prospective workspace directory to exist yet.
 */
function canonicalDirectoryPath(input: string): string {
  let existing = path.resolve(input);
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }

  try {
    existing = fs.realpathSync.native(existing);
  } catch {
    // path.resolve above remains the best available canonical form.
  }
  return path.resolve(existing, ...tail).normalize("NFC");
}

/** True when `child` is strictly below `parent`, including through symlinks. */
export function containsDirectory(parent: string, child: string): boolean {
  const relative = path.relative(
    canonicalDirectoryPath(parent),
    canonicalDirectoryPath(child),
  );
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Resolves the single storage root: BIGMOUTH_HOME when set and non-empty,
 * otherwise ~/.bigmouth. The root is derived from the home-directory API and
 * never from the working directory or the running code's location, so the same
 * root is used however the app is launched. The override is expanded and made
 * absolute against the home directory by the shared pipeline above; an override
 * that expands to nothing is a startup error there, not a silent fallback.
 */
function resolveAppDir(): string {
  const home = os.homedir();
  const override = process.env[HOME_ENV_VAR];
  if (override === undefined || override.trim() === "") {
    return path.join(home, `.${APP_NAME}`);
  }
  return expandAndResolve(override, home, HOME_ENV_VAR);
}

/**
 * Resolves the storage root and creates it, with the standard subdirectories.
 * Fails loudly if the root cannot be used — never a silent fall back to the
 * default, which would scatter a user's data across two locations.
 */
export function initStorageRoot(): void {
  appDir = resolveAppDir();
  workspacesJsonPath = path.join(appDir, "workspaces.json");
  logsDir = path.join(appDir, "logs");
  apiKeysPath = path.join(appDir, "api-keys.json");
  defaultWorkspacesDir = path.join(appDir, "workspaces");

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
}

function required(value: string | null): string {
  if (!value) throw new Error("storage root not initialized — call initStorageRoot() first");
  return value;
}

/** The storage root (`~/.bigmouth/`, or `BIGMOUTH_HOME`). */
export function getAppRoot(): string {
  return required(appDir);
}

/** The workspace registry file. */
export function getWorkspacesJsonPath(): string {
  return required(workspacesJsonPath);
}

export function getLogsDir(): string {
  return required(logsDir);
}

/** The storage-root secrets file — outside any workspace. */
export function getApiKeysPath(): string {
  return required(apiKeysPath);
}

/** Where an internally-managed workspace's folder is created. */
export function getDefaultWorkspacesDir(): string {
  return required(defaultWorkspacesDir);
}

/** The view-state store. Named here rather than joined at its own call site. */
export function getStateJsonPath(): string {
  return path.join(getAppRoot(), "state.json");
}

/** The write-through data-backup store. */
export function getBackupsDbPath(): string {
  return path.join(getAppRoot(), "backups.sqlite3");
}

/**
 * Absolutizes a user-supplied workspace directory while preserving literal
 * filename characters. A leading tilde is the one supported shorthand.
 */
export function expandWorkspacePath(p: string): string {
  const home = os.homedir();
  let value = p.trim();
  if (value === "~") {
    value = home;
  } else if (value.startsWith("~/") || value.startsWith("~\\")) {
    value = path.join(home, value.slice(2));
  }
  if (value.length === 0) throw new Error("Workspace directory is empty");

  // A workspace location is the user's literal filesystem choice. In
  // particular, Electron's native picker returns an already-absolute path: a
  // folder named `$archive` or `%drafts%` must keep that name. Expanding main-
  // process environment variables here both rewrote that choice and exposed
  // environment values to an unvalidated renderer IPC caller.
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(home, value);
}
