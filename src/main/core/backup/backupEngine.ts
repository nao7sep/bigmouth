/**
 * Runs one backup pass and returns a {@link BackupReport}. It never throws for an expected problem (a
 * fatal error is captured in the report) and never logs — the caller logs the report. See the data-backup
 * conventions: change is size + mtime, the archive mirrors `~/.bigmouth/`, and the archive is written and
 * renamed into place *before* the index so a crash never records a phantom backup. The rename is a
 * no-clobber create: if `backup-<archivedAt>.zip` is already taken, the stamp advances to the next free
 * millisecond, and that winning stamp is what both the zip name and the index records use.
 */
import fs from "node:fs";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { nanoid } from "nanoid";
import { getBackupIndexPath, getBackupsDir } from "../services/workspaceStore.js";
import { writeFileAtomic } from "../shared/atomicWrite.js";
import { formatForFilenameMs } from "../shared/timestamps.js";
import { collectRoots } from "./backupCollector.js";
import { selectChanged } from "./backupPlan.js";
import { toIsoSeconds } from "./backupTime.js";
import type { BackupCandidate, BackupIndex, BackupReport, BackupSkip } from "./backupTypes.js";

/** Captures everything changed since the last run. `now` is a parameter so the archive stamp is
 *  deterministic under test. */
export async function runBackup(now: Date): Promise<BackupReport> {
  try {
    return await runCore(now);
  } catch (fatal) {
    return { nothingChanged: false, filesArchived: 0, skips: [], indexWasReset: false, fatal };
  }
}

async function runCore(now: Date): Promise<BackupReport> {
  const { index, indexWasReset } = await loadIndex();
  const { candidates, skips } = await collectRoots();

  const changed = selectChanged(candidates, index);
  if (changed.length === 0) {
    return { nothingChanged: true, filesArchived: 0, skips, indexWasReset };
  }

  const written = await writeArchive(now, changed, skips);
  if (written.archived.length === 0) {
    // Every changed file vanished before it could be archived; nothing was written, nothing is recorded.
    return { nothingChanged: true, filesArchived: 0, skips, indexWasReset };
  }

  for (const item of written.archived) {
    index.entries.push({
      archivedAt: written.archivedAt,
      archivePath: item.archivePath,
      sizeBytes: item.sizeBytes,
      lastWriteUtc: toIsoSeconds(item.mtimeMs),
    });
  }
  // Index second: the archive is already in place, so a crash here just re-captures next run. Secrets are
  // excluded from backups (data-backup conventions), so the index carries no key material and needs no
  // mode hardening — it is written with the default mode.
  writeFileAtomic(getBackupIndexPath(), `${JSON.stringify(index, null, 2)}\n`);

  return {
    nothingChanged: false,
    archiveFileName: written.archiveFileName,
    filesArchived: written.archived.length,
    skips,
    indexWasReset,
  };
}

async function loadIndex(): Promise<{ index: BackupIndex; indexWasReset: boolean }> {
  const indexPath = getBackupIndexPath();
  let raw: string;
  try {
    raw = await fs.promises.readFile(indexPath, "utf-8");
  } catch (err) {
    // Absent index (first run, or freshly relocated root) is normal: back up everything.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { index: { entries: [] }, indexWasReset: false };
    }
    // Unreadable for another reason — treat as reset (full backup) rather than fail the run.
    return { index: { entries: [] }, indexWasReset: true };
  }

  try {
    const parsed = JSON.parse(raw) as BackupIndex;
    if (!parsed || !Array.isArray(parsed.entries)) throw new Error("malformed index");
    return { index: { entries: parsed.entries }, indexWasReset: false };
  } catch {
    // A corrupt index is deleted and treated as empty: the run becomes a full backup, costing one
    // redundant archive, never data.
    await tryDelete(indexPath);
    return { index: { entries: [] }, indexWasReset: true };
  }
}

/** Streams the changed files to a temp zip and renames it into place as `backup-<archivedAt>.zip` (see
 *  {@link renameIntoPlace} for the no-clobber advance), returning the winning stamp/name alongside the
 *  files that were actually archived (a file that vanished since collection is skipped, not recorded). */
async function writeArchive(
  now: Date,
  changed: readonly BackupCandidate[],
  skips: BackupSkip[],
): Promise<{ archivedAt: string; archiveFileName: string; archived: BackupCandidate[] }> {
  const dir = await ensureBackupsDir();
  const initialArchiveFileName = `backup-${formatForFilenameMs(now)}.zip`;
  const stem = path.basename(initialArchiveFileName, path.extname(initialArchiveFileName));
  const tempPath = path.join(dir, `${stem}-${nanoid()}.tmp`);

  const zip = new yazl.ZipFile();
  const archived: BackupCandidate[] = [];
  for (const item of changed) {
    if (!fs.existsSync(item.sourcePath)) {
      skips.push({ path: item.archivePath, reason: "vanished before archive" });
      continue;
    }
    zip.addFile(item.sourcePath, item.archivePath);
    archived.push(item);
  }
  if (archived.length === 0) {
    return { archivedAt: "", archiveFileName: "", archived };
  }

  zip.end();
  try {
    await pipeline(zip.outputStream, createWriteStream(tempPath));
    const placed = await renameIntoPlace(dir, tempPath, now);
    return { ...placed, archived };
  } catch (err) {
    await tryDelete(tempPath);
    throw err;
  }
}

/** Renames the temp zip into place as `backup-<archivedAt>.zip` without overwriting an existing archive (a
 *  no-clobber create): if that name is already taken — a second run stamped the same millisecond — the
 *  stamp advances to the next free millisecond (the same Date instant + 1 ms, re-formatted) and the check
 *  repeats, so the returned stamp is always the one that actually won the name (data-backup conventions). */
async function renameIntoPlace(
  dir: string,
  tempPath: string,
  from: Date,
): Promise<{ archivedAt: string; archiveFileName: string }> {
  let stamp = from;
  for (;;) {
    const archivedAt = formatForFilenameMs(stamp);
    const archiveFileName = `backup-${archivedAt}.zip`;
    const finalPath = path.join(dir, archiveFileName);
    if (!fs.existsSync(finalPath)) {
      await fs.promises.rename(tempPath, finalPath);
      return { archivedAt, archiveFileName };
    }
    stamp = new Date(stamp.getTime() + 1);
  }
}

async function ensureBackupsDir(): Promise<string> {
  const dir = getBackupsDir();
  // Default mode: secrets (api-keys.json) are excluded from backups, so no archive carries key material
  // and the directory needs no owner-only hardening (data-backup conventions).
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

async function tryDelete(target: string): Promise<void> {
  try {
    await fs.promises.rm(target, { force: true });
  } catch {
    // best effort: a leftover temp is harmless and lives under the excluded backups/ directory
  }
}
