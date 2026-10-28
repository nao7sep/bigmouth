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
 * never a failed save. At an ordinary quit the pending writes draw on the exit deadline; at OS session
 * end they are skipped.
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
// One recorder for the storage worker's lifetime, started at the first protected write.
let recorder: Recorder | null = null;
// The recorder failing to start or dying is reported once; recording then stays off.
let recorderFailed = false;

function release(write: BackupWrite): void {
  if (write.kind === "record-file") {
    try { fs.closeSync(write.fd); } catch { /* The descriptor has nothing left to protect. */ }
  }
}

// Lets the recorder go: what it has not been handed is dropped, and its exit is no longer news.
// Its messages still arrive, so a warning it sent before going is logged.
function letGo(owner: Recorder): void {
  recorder = null;
  for (const event of ["exit", "error", "messageerror"]) owner.worker.removeAllListeners(event);
  owner.queue.abandonPending();
  void owner.worker.terminate();
}

function disable(error: unknown): void {
  const owner = recorder;
  if (!owner) return;
  recorderFailed = true;
  letGo(owner);
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
    worker.on("message", (notice: BackupWorkerNotice) => {
      if (notice.kind === "warn") logWarn(notice.text, notice.fields);
      else queue.settled();
    });
    worker.on("messageerror", disable);
    worker.on("error", disable);
    worker.on("exit", (code) => disable(new Error(`The backup recorder exited with code ${code}.`)));
    recorder = { worker, queue };
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
  catch (error) { release(write); disable(error); }
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

/**
 * Ends recording for the process: the pending writes get `boundMs` to be applied and the store file
 * released (0 skips them, as at OS session end), then the recorder is let go without waiting.
 * Returns whether every pending write was applied.
 */
export function stopBackups(boundMs: number): boolean {
  const owner = recorder;
  if (!owner) return true;
  let applied = false;
  try {
    if (boundMs > 0) {
      owner.queue.flush();
      const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      owner.worker.postMessage({ kind: "close", signal } satisfies BackupWorkerRequest);
      applied = Atomics.wait(signal, 0, 0, boundMs) !== "timed-out";
    }
  } finally { letGo(owner); }
  return applied;
}
