/**
 * Atomic file write, and the single managed-text choke point layered on top of it.
 *
 * {@link writeFileAtomic} writes a sibling temp file in the target's own directory, then renames it
 * over the target. This prevents a torn replacement during process termination.
 * Final bytes and permissions are flushed before publication, then the changed
 * directory entry is flushed. Unsupported barriers or post-publication failures
 * are reported separately: publication succeeded, but power-loss protection is
 * unconfirmed. A filesystem or device may provide weaker guarantees than its API.
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
 * workspace's config.json, posts/*.md, and asset meta.json) all go through here, and only the deliberate
 * no-record sites (the secrets file, the volatile state.json, the rebuildable post index)
 * call writeFileAtomic directly, each with an inline "not recorded" reason at its call site.
 */

import fs from "node:fs";
import path from "node:path";
import { confirmPublication, flushStagedFile, flushPublishedPath } from "./publication.js";
import { versionFromStat } from "./fileVersion.js";
import { nanoid } from "nanoid";
import { record } from "../services/backupStore.js";

/**
 * Writes `content` to `filePath` atomically and returns true, or returns false
 * without writing when the file already holds exactly these bytes
 * (content-lifecycle-conventions: a write that changes nothing is skipped).
 */
export function writeFileAtomic(filePath: string, content: string | Buffer, mode?: number): boolean {
  return writeAtomic(filePath, content, mode).changed;
}

interface WriteOptions { knownChanged?: boolean; observe?: boolean }

function writeAtomic(filePath: string, content: string | Buffer, mode?: number, options: WriteOptions = {}): { changed: boolean; version: string | null } {
  if (!options.knownChanged && holdsBytes(filePath, content)) {
    if (mode !== undefined) {
      fs.chmodSync(filePath, mode);
      confirmPublication(filePath, flushPublishedPath(filePath));
    }
    return { changed: false, version: null };
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
  let bytesConfirmed = false;
  let stagedStat: fs.BigIntStats | undefined;
  try {
    fd = fs.openSync(tempPath, options.observe ? "wx+" : "wx", 0o600);
    created = true;
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, mode ?? keptMode ?? (0o666 & ~process.umask()));
    bytesConfirmed = flushStagedFile(fd);
    // The descriptor stays bound to our inode across publication. A path stat
    // after rename alone could accidentally certify an external replacement.
    if (options.observe) {
      try { stagedStat = fs.fstatSync(fd, { bigint: true }); } catch { /* Optional derived observation. */ }
    }
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    // A write that fails removes its own temp (storage-path-conventions).
    try { if (fd !== undefined) fs.closeSync(fd); } catch { /* Preserve the save failure. */ }
    try { if (created) fs.rmSync(tempPath, { force: true }); } catch { /* Preserve the save failure. */ }
    throw err;
  }
  let version: string | null = null;
  try {
    if (stagedStat) version = publishedVersion(fd, stagedStat, content);
  } catch { /* Publication succeeded; an unavailable observation only invalidates the cache. */ }
  finally {
    try { fs.closeSync(fd); } catch { bytesConfirmed = false; }
  }
  confirmPublication(filePath, bytesConfirmed);
  return { changed: true, version };
}

/** Verify the owned inode when rename changed its fingerprint. A path stat
 * cannot distinguish our bytes from an external replacement or in-place edit. */
function publishedVersion(fd: number, staged: fs.BigIntStats, content: string | Buffer): string | null {
  const before = fs.fstatSync(fd, { bigint: true });
  if (versionFromStat(before) === versionFromStat(staged)) return versionFromStat(before);
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (before.size !== BigInt(bytes.length)) return null;
  const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, bytes.length));
  let offset = 0;
  while (offset < bytes.length) {
    const length = fs.readSync(fd, chunk, 0, Math.min(chunk.length, bytes.length - offset), offset);
    if (length === 0 || !chunk.subarray(0, length).equals(bytes.subarray(offset, offset + length))) return null;
    offset += length;
  }
  const after = fs.fstatSync(fd, { bigint: true });
  return versionFromStat(before) === versionFromStat(after) ? versionFromStat(after) : null;
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
 * Returns an observation of the published inode, or null without a usable proof.
 * A caller that already compared authoritative content may skip the byte reread.
 */
export function writeManagedText(filePath: string, text: string, options?: WriteOptions): string | null {
  const bytes = Buffer.from(text, "utf8");
  const result = writeAtomic(filePath, bytes, undefined, options);
  if (result.changed) record(filePath, bytes);
  return result.version;
}
