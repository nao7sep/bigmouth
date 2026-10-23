import fs from "node:fs";
import path from "node:path";

// Publication and stable-storage confirmation are separate facts. Once a name
// has changed, a failed directory barrier must never turn it into a failed save
// that callers replay. Keep a launch-wide notice, including before UI startup.
let unconfirmed = false;
let listener: ((filePath: string) => void) | null = null;
let firstUnconfirmedPath = "";
export function durabilityUnconfirmed(): boolean { return unconfirmed; }
export function onDurabilityUnconfirmed(next: ((filePath: string) => void) | null): void {
  listener = next;
  if (unconfirmed) notify(firstUnconfirmedPath);
}
function notify(filePath: string): void {
  try { listener?.(filePath); } catch { /* Notification failure cannot undo publication. */ }
}
function reportUnconfirmedDurability(filePath: string): void {
  if (unconfirmed) return;
  unconfirmed = true;
  firstUnconfirmedPath = filePath;
  notify(filePath);
}

/** An unsupported barrier permits publication; actual staged I/O failures do not. */
export function flushStagedFile(fd: number): boolean {
  try { fs.fsyncSync(fd); return true; }
  catch (error) {
    if (["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

/** Returns confirmation only: the filesystem mutation has already happened. */
export function flushPublishedPath(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    fs.fsyncSync(fd);
    return true;
  } catch { return false; }
  finally {
    if (fd !== undefined) {
      // Closing a read-only handle cannot undo the completed barrier.
      try { fs.closeSync(fd); } catch { /* No mutation or retry follows. */ }
    }
  }
}

export function confirmPublication(filePath: string, bytesConfirmed: boolean, fromDir = path.dirname(filePath)): void {
  const destinationConfirmed = flushPublishedPath(path.dirname(filePath));
  const sourceConfirmed = fromDir === path.dirname(filePath) || flushPublishedPath(fromDir);
  if (!bytesConfirmed || !destinationConfirmed || !sourceConfirmed) reportUnconfirmedDurability(filePath);
}

/** Flush newly created directory entries, including each recursive ancestor. */
export function createDirectory(dir: string, mode?: number): void {
  const first = fs.mkdirSync(dir, { recursive: true, ...(mode === undefined ? {} : { mode }) });
  if (first === undefined) return;
  const last = path.dirname(first);
  let current = dir;
  let confirmed = true;
  for (;;) {
    if (!flushPublishedPath(current)) confirmed = false;
    if (current === last) break;
    current = path.dirname(current);
  }
  if (!confirmed) reportUnconfirmedDurability(dir);
}
