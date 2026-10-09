import fs from "node:fs";
import path from "node:path";

import { message } from "@shared/i18n/translate";
import { carryingText } from "@shared/i18n/carriedMessage";
import { utcNow, formatForFilename } from "./timestamps.js";

/** An unreadable store that could not be moved aside, so it must not be written over. */
export class QuarantineError extends Error {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    super(carryingText(message("store.quarantineFailed", { path: filePath })), { cause });
    this.name = "QuarantineError";
    this.filePath = filePath;
  }
}

// Moves an unreadable store aside to a timestamped neighbour and returns the new
// path. The name follows the derived-filename grammar: `<stem>-<UTC stamp>.invalid`,
// never the target's full filename with `.invalid` dot-appended. Seconds suffice
// (timestamp-conventions): a store is set aside at most once per load or key
// save. A neighbour of that name is never replaced, since it holds an earlier
// set-aside copy; the single-instance lock leaves no other writer between the
// check and the move. A failed move throws QuarantineError (store-recovery-
// conventions): the bytes it exists to preserve are still in place, so nothing
// may reset over them.
export function moveAsideInvalid(filePath: string): string {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);
  const movedTo = path.join(dir, `${stem}-${formatForFilename(utcNow())}.invalid`);
  try {
    if (fs.existsSync(movedTo)) {
      throw Object.assign(new Error(`${movedTo} already holds an earlier set-aside copy.`), { code: "EEXIST" });
    }
    fs.renameSync(filePath, movedTo);
  } catch (cause) {
    throw new QuarantineError(filePath, cause);
  }
  return movedTo;
}
