import fs from "node:fs";
import path from "node:path";

import { message } from "@shared/i18n/translate";
import { carryingText } from "@shared/i18n/carriedMessage";
import { utcNow, formatForFilenameMs } from "./timestamps.js";

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
// path. The name follows the derived-filename grammar: `<stem>-<millisecond UTC
// stamp>.invalid`, never the target's full filename with `.invalid` dot-appended.
// A failed move throws QuarantineError (store-recovery-conventions): the bytes
// it exists to preserve are still in place, so nothing may reset over them.
export function moveAsideInvalid(filePath: string): string {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);
  const movedTo = path.join(dir, `${stem}-${formatForFilenameMs(utcNow())}.invalid`);
  try {
    fs.renameSync(filePath, movedTo);
  } catch (cause) {
    throw new QuarantineError(filePath, cause);
  }
  return movedTo;
}
