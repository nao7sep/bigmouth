/**
 * Atomic file write.
 *
 * Writes a sibling temp file in the target's own directory, then renames it
 * over the target. A crash mid-write leaves either the old file or the new one,
 * never a truncated one — which is what keeps the JSON stores under the storage
 * root (app.json, settings.json, the index, …) readable after any interruption.
 * The rename is atomic only when the temp file is on the same filesystem as the
 * target, hence the same-directory temp.
 */

import fs from "node:fs";
import path from "node:path";

export function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${nextTempCounter()}.tmp`);
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

// A per-process counter keeps concurrent atomic writes from colliding on the
// temp filename without relying on Date.now()/Math.random().
let tempCounter = 0;
function nextTempCounter(): number {
  tempCounter += 1;
  return tempCounter;
}
