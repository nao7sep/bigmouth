import fs from "node:fs";
import path from "node:path";

import { utcNow, formatForFilenameMs } from "./timestamps.js";

// Moves an unreadable store aside to a timestamped neighbour, returning the new
// path or null when the move fails. The name follows the derived-filename
// grammar: `<stem>-<millisecond UTC stamp>.invalid`, never the target's full
// filename with `.invalid` dot-appended.
export function moveAsideInvalid(filePath: string): string | null {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);
  const movedTo = path.join(dir, `${stem}-${formatForFilenameMs(utcNow())}.invalid`);
  try {
    fs.renameSync(filePath, movedTo);
    return movedTo;
  } catch {
    return null;
  }
}
