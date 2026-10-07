/**
 * Atomic file write, and the single managed-text choke point layered on top of it.
 *
 * {@link writeFileAtomic} writes a sibling temp file in the target's own directory, then renames it
 * over the target. A crash mid-write leaves either the old file or the new one, never a truncated one —
 * which is what keeps the JSON stores under the storage root (workspaces.json, config.json, the post
 * index, …) readable after any interruption. The rename is atomic only when the temp file is on the
 * same filesystem as the target, hence the same-directory temp.
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
 * workspace's config.json, posts/*.md) all go through here, and only the deliberate no-record sites
 * (the secrets file, asset meta.json colocated with binaries, the volatile state.json, the post index)
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
  if (holdsBytes(filePath, content)) {
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

/** Whether `filePath` already holds exactly `content`; a file that cannot be read does not. */
export function holdsBytes(filePath: string, content: string | Buffer): boolean {
  let current: Buffer;
  try {
    current = fs.readFileSync(filePath);
  } catch {
    return false;
  }
  return current.equals(typeof content === "string" ? Buffer.from(content, "utf8") : content);
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
 */
export function writeManagedText(filePath: string, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  if (!writeFileAtomic(filePath, bytes)) return;
  record(filePath, bytes);
}
