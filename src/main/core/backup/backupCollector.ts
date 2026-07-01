/**
 * Discovers what to back up by reading the app's own state: the home root under `~/.bigmouth/` and every
 * registered workspace (wherever its `dataDirectory` lives), keyed by the workspace id. Produces the
 * stat'd candidates for {@link selectChanged} and records a skip for any dead or unreadable root. All I/O
 * here is metadata only — directory walks and `stat`; file contents are read later, when a changed file
 * is archived.
 */
import fs from "node:fs";
import path from "node:path";
import { getAppRoot, listWorkspaces } from "../services/workspaceStore.js";
import { forHomeFile, forWorkspaceFile, normalize } from "./archivePaths.js";
import { isExcludedDir, isExcludedFile, isNoiseOrTempFile } from "./homeRootExclusions.js";
import { truncateToSecondMs } from "./backupTime.js";
import type { BackupCandidate, BackupSkip } from "./backupTypes.js";

export interface CollectedRoots {
  candidates: BackupCandidate[];
  skips: BackupSkip[];
}

export async function collectRoots(): Promise<CollectedRoots> {
  const candidates: BackupCandidate[] = [];
  const skips: BackupSkip[] = [];
  await collectHomeRoot(candidates, skips);
  await collectWorkspaces(candidates, skips);
  return { candidates, skips };
}

/** Walks `~/.bigmouth/`, pruning the excluded `logs/`, `backups/`, and `workspaces/` subtrees (the last
 *  because workspaces are captured from the registry, not double-walked here). */
async function collectHomeRoot(candidates: BackupCandidate[], skips: BackupSkip[]): Promise<void> {
  const root = getAppRoot();
  await walk(root, root, skips, async (fullPath, relative) => {
    if (!isExcludedFile(relative)) {
      await addCandidate(candidates, skips, fullPath, forHomeFile(relative));
    }
  }, (relativeDir) => isExcludedDir(relativeDir));
}

async function collectWorkspaces(candidates: BackupCandidate[], skips: BackupSkip[]): Promise<void> {
  for (const workspace of listWorkspaces()) {
    const dir = workspace.dataDirectory;
    if (!fs.existsSync(dir)) {
      skips.push({ path: dir, reason: `workspace directory not found: ${workspace.name}` });
      continue;
    }
    await walk(dir, dir, skips, async (fullPath, relative) => {
      // The OS-noise floor and *.tmp temporaries litter any directory the user browses, including a
      // workspace's external dataDirectory (e.g. assets/<postId>/.DS_Store), so drop them here too. The
      // home-root EXCLUDED_DIRS pruning does NOT apply — those names are meaningful data inside a workspace.
      if (isNoiseOrTempFile(path.basename(fullPath))) return;
      await addCandidate(candidates, skips, fullPath, forWorkspaceFile(workspace.id, relative));
    });
  }
}

/**
 * Recursively yields each file under `root` (relative path forward-slash normalized), skipping any
 * subdirectory the optional `pruneDir` predicate rejects. An unreadable directory is a logged skip, not a
 * throw, so the rest of the tree is still captured.
 */
async function walk(
  root: string,
  dir: string,
  skips: BackupSkip[],
  onFile: (fullPath: string, relative: string) => Promise<void>,
  pruneDir?: (relativeDir: string) => boolean,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    skips.push({ path: dir, reason: `could not enumerate: ${errorMessage(err)}` });
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relative = normalize(path.relative(root, fullPath));
    if (entry.isDirectory()) {
      if (!pruneDir?.(relative)) {
        await walk(root, fullPath, skips, onFile, pruneDir);
      }
    } else if (entry.isFile()) {
      await onFile(fullPath, relative);
    }
  }
}

async function addCandidate(
  candidates: BackupCandidate[],
  skips: BackupSkip[],
  sourcePath: string,
  archivePath: string,
): Promise<void> {
  try {
    const stat = await fs.promises.stat(sourcePath);
    candidates.push({
      sourcePath,
      archivePath,
      sizeBytes: stat.size,
      mtimeMs: truncateToSecondMs(stat.mtimeMs),
    });
  } catch (err) {
    skips.push({ path: sourcePath, reason: `could not stat: ${errorMessage(err)}` });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
