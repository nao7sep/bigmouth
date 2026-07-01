/**
 * Pure mapping from a file's role to its entry path within the archive, which mirrors what
 * `~/.bigmouth/` would contain if every workspace were stored internally (see the data-backup
 * conventions): home files at their real relative path, and workspaces — wherever they live on disk —
 * under `workspaces/<workspaceId>/`. All entry paths use forward slashes.
 */

/** Normalizes a filesystem-relative path to a forward-slash archive path. */
export function normalize(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** A file directly under `~/.bigmouth/`: its relative path is the archive path (`workspaces.json`). */
export function forHomeFile(relativePath: string): string {
  return normalize(relativePath);
}

/** A file inside a workspace, keyed by the workspace id: `workspaces/<id>/<relative-to-dataDirectory>`. */
export function forWorkspaceFile(workspaceId: string, relativeToDataDir: string): string {
  return `workspaces/${workspaceId}/${normalize(relativeToDataDir)}`;
}
