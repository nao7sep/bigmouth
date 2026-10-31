/**
 * Atomic file write, and the single managed-text choke point layered on top of it.
 *
 * {@link writeFileAtomic} writes a sibling temp file in the target's own directory, then renames it
 * over the target. Final bytes and permissions are flushed before the rename, so neither process
 * termination nor a crash leaves a torn or empty replacement; the folder itself is not flushed.
 *
 * The temp name is `<stem>-<nanoid>.tmp` (the derived-filename grammar): the nanoid is what lets two
 * concurrent unlocked writers of the same target each rename their own complete content into place
 * without ever sharing — and tearing — one temp file.
 *
 * Replacing an existing file carries its permission mode onto the temp before the rename. Its extended
 * attributes and Finder tags are not carried: Node cannot copy them without a native dependency.
 *
 * Stages stay private while their bytes are written (storage-path-conventions).
 * The explicit or inherited destination mode is applied only after the write.
 *
 * {@link writeManagedText} is the ONE place a durable managed-text write records to the data-backup
 * store. It writes atomically, and STRICTLY AFTER the rename lands records the exact bytes it just
 * wrote (data-backup conventions). A managed-text write that reaches disk through the bare
 * {@link writeFileAtomic} instead is a silent backup gap — so the record sites (workspaces.json, each
 * workspace's config.json, posts/*.md, and asset assets.json) all go through here, and only the deliberate
 * no-record sites (the secrets file and the volatile state.json)
 * call writeFileAtomic directly, each with an inline "not recorded" reason at its call site.
 */

import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { record } from "../services/backupStore.js";

/**
 * Writes `content` to `filePath` atomically and returns true, or returns false
 * without writing when the file already holds exactly these bytes
 * (content-lifecycle-conventions: a write that changes nothing is skipped).
 */
export function writeFileAtomic(filePath: string, content: string | Buffer, mode?: number): boolean {
  return writeAtomic(filePath, content, mode);
}

interface WriteOptions { knownChanged?: boolean }

function writeAtomic(filePath: string, content: string | Buffer, mode?: number, options: WriteOptions = {}): boolean {
  if (!options.knownChanged && holdsBytes(filePath, content)) {
    if (mode !== undefined) fs.chmodSync(filePath, mode);
    return false;
  }
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);
  const tempPath = path.join(dir, `${stem}-${nanoid()}.tmp`);
  // A replace keeps the file's permissions (content-lifecycle-conventions); an
  // explicit mode, the secrets file's, wins over them.
  const keptMode = mode === undefined ? existingMode(filePath) : undefined;
  let created = false;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    created = true;
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, mode ?? keptMode ?? (0o666 & ~process.umask()));
    flushStagedFile(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    // A write that fails removes its own temp (storage-path-conventions).
    try { if (fd !== undefined) fs.closeSync(fd); } catch { /* Preserve the save failure. */ }
    try { if (created) fs.rmSync(tempPath, { force: true }); } catch { /* Preserve the save failure. */ }
    throw err;
  }
  return true;
}

/**
 * Flushes a staged file's bytes and permissions before it is renamed into place, so a crash cannot
 * leave the target empty or torn. A filesystem without the call (some network shares) still gets the
 * ordinary write and rename; any other failure fails the save.
 */
export function flushStagedFile(fd: number): void {
  try { fs.fsyncSync(fd); }
  catch (error) {
    if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

/**
 * Whether `filePath` already holds exactly `content`; a file that cannot be read does not. A file
 * of another size is not read, so a write never reads a large file it is about to replace.
 */
export function holdsBytes(filePath: string, content: string | Buffer): boolean {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  let current: Buffer;
  try {
    if (fs.statSync(filePath).size !== bytes.length) return false;
    current = fs.readFileSync(filePath);
  } catch {
    return false;
  }
  return current.equals(bytes);
}

/** The permission bits of the file a write is about to replace, or undefined when there is none. */
export function existingMode(filePath: string): number | undefined {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  return stat ? stat.mode & 0o7777 : undefined;
}

/**
 * The single managed-text atomic-write choke point: writes `text` atomically to `filePath`, then —
 * strictly AFTER the rename lands — records the exact UTF-8 bytes just written into the data-backup
 * store (data-backup conventions).
 *
 * Recording after the rename is what avoids a "backup of a save that never happened": if the rename
 * threw, the history would hold a version that never reached disk. The `record` call reuses the same
 * `bytes` buffer we just wrote — never a re-read of the file, which could capture a concurrent writer's
 * content instead of what this call wrote. The record is best-effort and silent; it never throws back
 * into this write and never affects the save's success (see backupStore).
 * A caller that already compared authoritative content may skip the byte reread.
 */
export function writeManagedText(filePath: string, text: string, options?: WriteOptions): void {
  const bytes = Buffer.from(text, "utf8");
  if (writeAtomic(filePath, bytes, undefined, options)) record(filePath, bytes);
}
