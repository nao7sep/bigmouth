/**
 * Atomic file write.
 *
 * Writes a sibling temp file in the target's own directory, then renames it
 * over the target. A crash mid-write leaves either the old file or the new one,
 * never a truncated one — which is what keeps the JSON stores under the storage
 * root (workspaces.json, settings.json, the index, …) readable after any interruption.
 * The rename is atomic only when the temp file is on the same filesystem as the
 * target, hence the same-directory temp.
 *
 * The temp name is `<stem>-<nanoid>.tmp` (the derived-filename grammar): the
 * nanoid is what lets two concurrent unlocked writers of the same target each
 * rename their own complete content into place without ever sharing — and
 * tearing — one temp file.
 *
 * An optional `mode` is applied at creation — the temp file is opened with those
 * permissions, so the secret content never touches disk at a looser default for
 * even an instant (a chmod after the write would leave exactly that window). Used
 * for the `0600` secrets file; the umask only clears bits, so `0600` stays `0600`.
 */

import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";

export function writeFileAtomic(filePath: string, content: string, mode?: number): void {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);
  const tempPath = path.join(dir, `${stem}-${nanoid()}.tmp`);
  fs.writeFileSync(tempPath, content, mode !== undefined ? { mode } : undefined);
  fs.renameSync(tempPath, filePath);
}
