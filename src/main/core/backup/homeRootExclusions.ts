/**
 * The optimistic exclude list for the `~/.bigmouth/` home root: everything under the root is backed up
 * except the entries here. Pure, so the "did we pick the right files?" decision is unit-testable.
 *
 * `workspaces.json` is captured like any durable file. `api-keys.json` is a secret and is EXCLUDED —
 * secrets are kept out of backups (see the data-backup conventions), so there is nothing to protect and no
 * mode hardening. Also excluded are: `logs/` (recreatable), `backups/` (the feature's own output —
 * capturing it would recurse), `workspaces/` (the default internal workspaces, which are captured from the
 * registry instead, so they are not double-walked here), `*.tmp` (atomic-write temporaries), `*.invalid`
 * (quarantine files the secret store sets aside — `<stem>-<stamp>.invalid`, matched case-insensitively),
 * and the OS folder-metadata litter a file manager drops into any directory the user opens (`.DS_Store`,
 * `Thumbs.db`, `desktop.ini` — the fleet floor, matched case-insensitively). Paths are the forward-slash
 * relative path under the root. (Symlinks are never followed: the collector's walk uses the directory
 * entry's own type, so a link is neither descended nor archived.)
 */
import { normalize } from "./archivePaths.js";

const EXCLUDED_DIRS = ["logs", "backups", "workspaces"];

// Secret files never backed up (data-backup conventions: secrets are excluded). `api-keys.json` is the
// bigmouth secret store; excluding it means the backup carries no key material and needs no hardening.
// Compared against the lowercased base name at the home root.
const EXCLUDED_FILE_NAMES = new Set(["api-keys.json"]);

// OS/file-manager metadata that appears under the root just from browsing it (see the data-backup
// conventions' fleet floor). Compared against the lowercased base name at any depth.
const OS_NOISE_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * True when a file's base name is fleet-wide litter that must never be archived in any root: the OS
 * folder-metadata floor (`.DS_Store`, `Thumbs.db`, `desktop.ini`, case-insensitive), an atomic-write
 * `*.tmp` temporary, or a `*.invalid` quarantine file the secret store sets aside (`<stem>-<stamp>.invalid`,
 * case-insensitive). These apply at any depth in any directory the user browses, so both the home-root
 * walk and the workspace walk share this predicate. The `EXCLUDED_DIRS` pruning below is home-root-relative
 * and deliberately NOT part of this — a workspace's own `logs`/`backups`/`workspaces` subdir is real data.
 */
export function isNoiseOrTempFile(fileBaseName: string): boolean {
  const lower = fileBaseName.toLowerCase();
  return lower.endsWith(".tmp") || lower.endsWith(".invalid") || OS_NOISE_NAMES.has(lower);
}

/** True when a home-root file must not be backed up. */
export function isExcludedFile(relativePath: string): boolean {
  const path = normalize(relativePath);
  const base = baseName(path);
  if (isNoiseOrTempFile(base)) return true;
  if (EXCLUDED_FILE_NAMES.has(base.toLowerCase())) return true;
  return EXCLUDED_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`));
}

/** True when a home-root subdirectory should be pruned (not descended into) during the walk. */
export function isExcludedDir(relativeDirPath: string): boolean {
  const path = normalize(relativeDirPath);
  return EXCLUDED_DIRS.includes(path);
}
