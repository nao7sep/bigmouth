/**
 * The optimistic exclude list for the `~/.bigmouth/` home root: everything under the root is backed up
 * except the entries here. Pure, so the "did we pick the right files?" decision is unit-testable.
 *
 * `workspaces.json` and `api-keys.json` are captured like any durable file (secrets are backed up too —
 * see the data-backup conventions). Excluded are: `logs/` (recreatable), `backups/` (the feature's own
 * output — capturing it would recurse), `workspaces/` (the default internal workspaces, which are
 * captured from the registry instead, so they are not double-walked here), `*.tmp` (atomic-write
 * temporaries), and the OS folder-metadata litter a file manager drops into any directory the user opens
 * (`.DS_Store`, `Thumbs.db`, `desktop.ini` — the fleet floor, matched case-insensitively). Paths are the
 * forward-slash relative path under the root. (Symlinks are never followed: the collector's walk uses the
 * directory entry's own type, so a link is neither descended nor archived.)
 */
import { normalize } from "./archivePaths.js";

const EXCLUDED_DIRS = ["logs", "backups", "workspaces"];

// OS/file-manager metadata that appears under the root just from browsing it (see the data-backup
// conventions' fleet floor). Compared against the lowercased base name at any depth.
const OS_NOISE_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** True when a home-root file must not be backed up. */
export function isExcludedFile(relativePath: string): boolean {
  const path = normalize(relativePath);
  if (path.toLowerCase().endsWith(".tmp")) return true;
  if (OS_NOISE_NAMES.has(baseName(path).toLowerCase())) return true;
  return EXCLUDED_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`));
}

/** True when a home-root subdirectory should be pruned (not descended into) during the walk. */
export function isExcludedDir(relativeDirPath: string): boolean {
  const path = normalize(relativeDirPath);
  return EXCLUDED_DIRS.includes(path);
}
