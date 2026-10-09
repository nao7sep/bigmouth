/**
 * The data-backup history (data-backup-conventions): `backups.sqlite3` directly under BigMouth's
 * storage root (`BIGMOUTH_DATA_DIR` or `~/.bigmouth`, resolved in one place by {@link getAppRoot}),
 * holding the last version of each protected file saved in each session. What is protected is decided
 * at each write boundary: post files, the workspace registry, both settings files, and attachments with
 * their `meta.json` call {@link record} after their write lands; the post index, view state, secrets and
 * records never do. There is no capture at launch, on a timer or at exit, and no restore path.
 *
 * Recording runs on its own thread (backupWorker.ts), which applies writes in save order, so a slow or
 * locked store never holds up the save that called it or the storage work behind it. `record` hands the
 * thread a copy of the exact bytes written and returns. Failures are the thread's to report: one warn,
 * never a failed save. At an ordinary quit the pending writes get a short bound; at OS session end they
 * are skipped.
 *
 * SQLite binding: Node's built-in `node:sqlite`, which needs no native rebuild against Electron's Node ABI.
 */

import { Worker } from "node:worker_threads";
import { getBackupsDbPath } from "./storagePaths.js";
import { formatUtcIso } from "../shared/timestamps.js";
import { warn as logWarn, serializeError } from "./logger.js";
import type { BackupWorkerNotice, BackupWorkerRequest } from "./backupWorker.js";

// One session per process launch: every row this launch writes carries it.
const SESSION_ID = formatUtcIso(new Date());

// The recorder's module. Tests run this file from source beside backupWorker.ts; in the build this
// module lands in a shared chunk, so the storage worker's entry names backup-worker.js beside itself.
let recorderModule: URL | null = import.meta.url?.endsWith(".ts") ? new URL("./backupWorker.ts", import.meta.url) : null;

/** Where the recorder's module is; the storage worker's entry sets it in the build. */
export function useBackupRecorderModule(url: URL): void {
  recorderModule = url;
}

// The largest file kept in one value; a larger one is kept in parts of this size. Well under
// SQLite's limit of about 1 GB per value, since an attachment's size is a user setting.
let partSize = 256 * 1024 * 1024;

/** For tests: the part size, so a small file can exercise the parts. */
export function useBackupPartSize(bytes: number): void {
  partSize = bytes;
}

let recorder: Worker | null = null;
// The recorder failing to start or dying is reported once; recording then stays off.
let recorderFailed = false;

function ensureRecorder(): Worker | null {
  if (recorder) return recorder;
  if (recorderFailed) return null;
  try {
    if (!recorderModule) throw new Error("The backup recorder's module is not known.");
    const created = new Worker(recorderModule);
    created.unref();
    created.on("message", (notice: BackupWorkerNotice) => logWarn(notice.text, notice.fields));
    const lost = (error: unknown) => {
      if (recorder !== created) return;
      recorder = null;
      recorderFailed = true;
      logWarn("backup recorder stopped; recording disabled for this session", { error: serializeError(error) });
    };
    created.on("error", lost);
    created.on("exit", (code) => lost(new Error(`The backup recorder exited with code ${code}.`)));
    recorder = created;
  } catch (error) {
    recorderFailed = true;
    logWarn("backup recorder could not start; recording disabled for this session", { error: serializeError(error) });
  }
  return recorder;
}

/**
 * Records one protected write: `absolutePath` is the full absolute path of the file as written, and
 * `bytes` the exact bytes just written, never a re-read of the file. Returns at once; never throws.
 */
export function record(absolutePath: string, bytes: Uint8Array): void {
  try {
    const worker = ensureRecorder();
    if (!worker) return;
    // A copy the thread owns: the caller keeps using its own buffer.
    const copy = new Uint8Array(bytes);
    worker.postMessage(
      {
        kind: "record",
        file: getBackupsDbPath(),
        sessionId: SESSION_ID,
        path: absolutePath,
        bytes: copy,
        writtenAt: new Date().toISOString(),
        partSize,
      } satisfies BackupWorkerRequest,
      [copy.buffer],
    );
  } catch (error) {
    logWarn("backup store: failed to hand a write to the recorder", { file: absolutePath, error: serializeError(error) });
  }
}

// Asks the recorder to answer once every earlier write is applied, and waits up to `boundMs`.
function settle(kind: "drain" | "close", boundMs: number): boolean {
  const worker = recorder;
  if (!worker) return true;
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  worker.postMessage({ kind, signal } satisfies BackupWorkerRequest);
  return Atomics.wait(signal, 0, 0, boundMs) !== "timed-out";
}

/** Waits up to `boundMs` for the writes already handed over; true when all were applied. */
export function drainBackups(boundMs: number): boolean {
  return settle("drain", boundMs);
}

/**
 * Ends recording for the process: the pending writes get `boundMs` (0 skips them, as at OS session
 * end), then the recorder is let go without waiting.
 */
export function stopBackups(boundMs: number): void {
  const worker = recorder;
  if (!worker) return;
  // Closing the store with the drain releases its file before the thread goes.
  if (boundMs > 0) settle("close", boundMs);
  recorder = null;
  void worker.terminate();
}

/**
 * Applies the pending writes and releases the store file, keeping the recorder for the next write.
 * For tests that relocate the storage root between cases; the next write opens the store under the
 * current root.
 */
export function closeBackupStore(): void {
  settle("close", 5000);
}
