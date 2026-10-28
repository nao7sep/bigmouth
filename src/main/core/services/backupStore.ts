/**
 * The data-backup history (data-backup-conventions): `backups.sqlite3` directly under BigMouth's
 * storage root (`BIGMOUTH_DATA_DIR` or `~/.bigmouth`, resolved in one place by {@link getAppRoot}),
 * holding the last version of each protected file saved in each session. What is protected is decided
 * at each write boundary: post files, the workspace registry, both settings files and an attachment's
 * `meta.json` call {@link record} after their write lands, and an installed attachment calls
 * {@link recordFile}; the post index, view state, secrets and records never do. There is no capture at launch, on a timer or at exit, and no restore path.
 *
 * Recording runs on its own thread (backupWorker.ts), which applies writes in save order, so a slow or
 * locked store never holds up the save that called it or the storage work behind it. `record` queues a
 * copy of the exact bytes written and returns; `recordFile` queues an installed attachment the app never
 * held whole, to be read from disk. One write is in flight at a time, and a newer save of a path replaces
 * its pending version. Failures are the thread's to report: one warn,
 * never a failed save. At an ordinary quit the pending writes get a short bound; at OS session end they
 * are skipped.
 *
 * SQLite binding: Node's built-in `node:sqlite`, which needs no native rebuild against Electron's Node ABI.
 */

import fs from "node:fs";
import { BackupAdmission } from "./backupAdmission.js";
import { Worker } from "node:worker_threads";
import { getBackupsDbPath } from "./storagePaths.js";
import { formatUtcIso } from "../shared/timestamps.js";
import { warn as logWarn, serializeError } from "./logger.js";
import type { BackupWorkerNotice, BackupWorkerRequest, BackupWrite } from "./backupWorker.js";

// One session per process launch: every row this launch writes carries it.
const SESSION_ID = formatUtcIso(new Date());

// The recorder's module. Tests run this file from source beside backupWorker.ts; in the build this
// module lands in a shared chunk, so the storage worker's entry names backup-worker.js beside itself.
let recorderModule: URL | null = import.meta.url?.endsWith(".ts") ? new URL("./backupWorker.ts", import.meta.url) : null;

/** Where the recorder's module is; the storage worker's entry sets it in the build. */
export function useBackupRecorderModule(url: URL): void {
  recorderModule = url;
}

interface Recorder { worker: Worker; queue: BackupAdmission }
let recorder: Recorder | null = null;
// The recorder failing to start or dying is reported once; recording then stays off.
let recorderFailed = false;

function release(write: BackupWrite): void {
  if (write.kind === "record-file") {
    try { fs.closeSync(write.fd); } catch { /* The descriptor has nothing left to protect. */ }
  }
}

function disable(owner: Recorder, error: unknown): void {
  if (recorder !== owner) return;
  recorder = null;
  recorderFailed = true;
  owner.queue.abandonPending();
  void owner.worker.terminate();
  logWarn("backup recorder stopped; recording disabled for this session", { error: serializeError(error) });
}

function ensureRecorder(): Recorder | null {
  if (recorder) return recorder;
  if (recorderFailed) return null;
  try {
    if (!recorderModule) throw new Error("The backup recorder's module is not known.");
    const worker = new Worker(recorderModule);
    worker.unref();
    const queue = new BackupAdmission(
      (write) => worker.postMessage(write satisfies BackupWorkerRequest,
        write.kind === "record" ? [write.bytes.buffer as ArrayBuffer] : []),
      release,
    );
    const created = { worker, queue };
    worker.on("message", (notice: BackupWorkerNotice) => {
      if (notice.kind === "warn") logWarn(notice.text, notice.fields);
      else if (recorder === created) queue.settled();
    });
    const lost = (error: unknown) => disable(created, error);
    worker.on("messageerror", lost);
    worker.on("error", lost);
    worker.on("exit", (code) => lost(new Error(`The backup recorder exited with code ${code}.`)));
    recorder = created;
  } catch (error) {
    recorderFailed = true;
    logWarn("backup recorder could not start; recording disabled for this session", { error: serializeError(error) });
  }
  return recorder;
}

function offer(write: BackupWrite): void {
  const owner = ensureRecorder();
  if (!owner) { release(write); return; }
  try { owner.queue.offer(write); }
  catch (error) { release(write); disable(owner, error); }
}

/**
 * Records one protected write: `absolutePath` is the full absolute path of the file as written, and
 * `bytes` the exact bytes just written, never a re-read of the file. Returns at once; never throws.
 */
export function record(absolutePath: string, bytes: Uint8Array): void {
  try {
    offer({ kind: "record", file: getBackupsDbPath(), sessionId: SESSION_ID, path: absolutePath,
      bytes, writtenAt: new Date().toISOString() });
  } catch (error) {
    logWarn("backup store: failed to capture a write", { file: absolutePath, error: serializeError(error) });
  }
}

/**
 * Records an attachment installed from a staged copy whose bytes the app never held whole:
 * `fd` is open for reading on the installed file, and `sha256` and `size` describe the bytes the
 * app copied. The recorder reads the file through `fd`, so a later replace or delete of the path
 * cannot change what is recorded, and records it only if it still hashes to `sha256`. This call
 * owns `fd` and closes it on this thread once the recorder has read it, or at once when it is not
 * recorded. Returns at once; never throws.
 */
export function recordFile(absolutePath: string, fd: number, sha256: string, size: number): void {
  try {
    offer({ kind: "record-file", file: getBackupsDbPath(), sessionId: SESSION_ID, path: absolutePath,
      fd, sha256, size, writtenAt: new Date().toISOString() });
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* Capture never acquired ownership. */ }
    logWarn("backup store: failed to capture a write", { file: absolutePath, error: serializeError(error) });
  }
}

// Hands over every pending write, asks the recorder to answer once all are applied, and waits up to `boundMs`.
function settle(kind: "drain" | "close", boundMs: number): boolean {
  const owner = recorder;
  if (!owner) return true;
  try {
    owner.queue.flush();
    const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    owner.worker.postMessage({ kind, signal } satisfies BackupWorkerRequest);
    return Atomics.wait(signal, 0, 0, boundMs) !== "timed-out";
  } catch (error) { disable(owner, error); return false; }
}

/** Waits up to `boundMs` for the writes already captured; true when all were applied. */
export function drainBackups(boundMs: number): boolean {
  return settle("drain", boundMs);
}

/**
 * Ends recording for the process: the pending writes get `boundMs` (0 skips them, as at OS session
 * end), then the recorder is let go without waiting.
 */
export function stopBackups(boundMs: number): void {
  const owner = recorder;
  if (!owner) return;
  // Closing the store with the drain releases its file before the thread goes.
  if (boundMs > 0) settle("close", boundMs);
  recorder = null;
  owner.queue.abandonPending();
  void owner.worker.terminate();
}

/**
 * Applies the pending writes and releases the store file, keeping the recorder for the next write.
 * For tests that relocate the storage root between cases; the next write opens the store under the
 * current root.
 */
export function closeBackupStore(): void {
  settle("close", 5000);
}
