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
 * An optional `mode` is applied at creation — the temp file is opened with those permissions, so the
 * secret content never touches disk at a looser default for even an instant (a chmod after the write
 * would leave exactly that window). Used for the `0600` secrets file; the umask only clears bits, so
 * `0600` stays `0600`.
 *
 * {@link writeManagedText} is the ONE place a durable managed-text write records to the data-backup
 * store. It writes atomically, and STRICTLY AFTER the rename lands records the exact bytes it just
 * wrote (data-backup conventions). A managed-text write that reaches disk through the bare
 * {@link writeFileAtomic} instead is a silent backup gap — so the record sites (workspaces.json, each
 * workspace's config.json, posts/*.md, the post index) all go through here, and only the deliberate
 * no-record sites (the secrets file, asset meta.json colocated with binaries) call writeFileAtomic
 * directly, each with an inline "not recorded" reason at its call site.
 */

import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { record } from "../services/backupStore.js";

export function writeFileAtomic(filePath: string, content: string | Buffer, mode?: number): void {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);
  const tempPath = path.join(dir, `${stem}-${nanoid()}.tmp`);
  fs.writeFileSync(tempPath, content, mode !== undefined ? { mode } : undefined);
  fs.renameSync(tempPath, filePath);
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
  writeFileAtomic(filePath, bytes);
  record(filePath, bytes);
}
