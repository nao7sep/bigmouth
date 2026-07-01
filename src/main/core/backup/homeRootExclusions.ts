/**
 * The optimistic exclude list for the `~/.bigmouth/` home root: everything under the root is backed up
 * except the entries here. Pure, so the "did we pick the right files?" decision is unit-testable.
 *
 * `workspaces.json` and `api-keys.json` are captured like any durable file (secrets are backed up too —
 * see the data-backup conventions). Excluded are: `logs/` (recreatable), `backups/` (the feature's own
 * output — capturing it would recurse), `workspaces/` (the default internal workspaces, which are
 * captured from the registry instead, so they are not double-walked here), and `*.tmp` (atomic-write
 * temporaries). Paths are the forward-slash relative path under the root.
 */
import { normalize } from "./archivePaths.js";

const EXCLUDED_DIRS = ["logs", "backups", "workspaces"];

/** True when a home-root file must not be backed up. */
export function isExcludedFile(relativePath: string): boolean {
  const path = normalize(relativePath);
  if (path.endsWith(".tmp")) return true;
  return EXCLUDED_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`));
}

/** True when a home-root subdirectory should be pruned (not descended into) during the walk. */
export function isExcludedDir(relativeDirPath: string): boolean {
  const path = normalize(relativeDirPath);
  return EXCLUDED_DIRS.includes(path);
}
