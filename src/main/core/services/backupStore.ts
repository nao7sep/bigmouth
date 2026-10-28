/**
 * The data-backup history (data-backup-conventions): `backups.sqlite3` directly under BigMouth's
 * storage root (`BIGMOUTH_DATA_DIR` or `~/.bigmouth`, resolved in one place by {@link getAppRoot}),
 * holding the last version of each protected file saved in each session. What is protected is decided
 * at each write boundary: post files, the workspace registry, both settings files and an attachment's
 * `meta.json` call {@link record} after their write lands, and an installed attachment calls
 * {@link recordFile}; the post index, view state, secrets and records never do. There is no capture at launch, on a timer or at exit, and no restore path.
 *
 * Recording runs on its own thread (backupWorker.ts), which applies writes in save order, so a slow or
 * locked store never holds up the save that called it or the storage work behind it. `record` hands the
 * bounded queue a copy of the exact bytes written and returns; `recordFile` hands it an installed attachment the
 * app never held whole, to be read from disk in parts. Failures are the thread's to report: one warn,
 * never a failed save. At an ordinary quit the pending writes get a short bound; at OS session end they
 * are skipped.
 *
 * SQLite binding: Node's built-in `node:sqlite`, which needs no native rebuild against Electron's Node ABI.
 */

import fs from "node:fs";
import os from "node:os";
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

// The largest file kept in one value; a larger one is kept in parts of this size. Well under
// SQLite's limit of about 1 GB per value, and small enough that recording an attachment of any
// size holds only one part in the recorder's memory.
let partSize = 8 * 1024 * 1024;

/** For tests: the part size, so a small file can exercise the parts. */
export function useBackupPartSize(bytes: number): void {
  partSize = bytes;
}

interface Recorder { worker: Worker; queue: BackupAdmission }
let recorder: Recorder | null = null;
let recorderFailed = false;
let retirement: Promise<void> | null = null;

function release(write: BackupWrite): void {
  if (write.kind === "record-file") {
    try { fs.closeSync(write.fd); } catch { /* No retained version remains to protect. */ }
  }
}

function disable(owner: Recorder, error: unknown): void {
  if (recorder !== owner) return;
  recorder = null;
  recorderFailed = true;
  owner.queue.abandonPending();
  // Failure notification is not proof that native work has stopped using its descriptor.
  retirement = owner.worker.terminate().then(() => { owner.queue.retired(); retirement = null; });
  logWarn("backup recorder stopped; recording disabled for this session", { error: serializeError(error) });
}

function ensureRecorder(): Recorder | null {
  if (recorder) return recorder;
  if (recorderFailed || retirement) return null;
  try {
    if (!recorderModule) throw new Error("The backup recorder's module is not known.");
    const worker = new Worker(recorderModule);
    worker.unref();
    // Best effort history must not retain unbounded copies or open files behind a slow disk.
    // This is an ownership budget, not a free-memory check or a limit on primary saves.
    const queue = new BackupAdmission(
      { bytes: Math.floor(os.totalmem() / 256), descriptors: os.availableParallelism() * 8 },
      (write, signal) => worker.postMessage({ ...write, signal } satisfies BackupWorkerRequest,
        write.kind === "record" ? [write.bytes.buffer as ArrayBuffer] : []),
      release,
      () => logWarn("backup recorder is full; some saved versions could not be retained"),
    );
    const created = { worker, queue };
    worker.on("message", (notice: BackupWorkerNotice) => {
      if (notice.kind === "warn") logWarn(notice.text, notice.fields);
      else if (recorder === created) {
        try { queue.reap(); } catch (error) { disable(created, error); }
      }
    });
    const lost = (error: unknown) => disable(created, error);
    worker.on("messageerror", lost);
    worker.on("error", lost);
    worker.on("exit", (code) => {
      queue.retired();
      lost(new Error(`The backup recorder exited with code ${code}.`));
    });
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
  catch (error) { disable(owner, error); }
}

/** Records exact published bytes; never waits for recording or throws to the primary save. */
export function record(absolutePath: string, bytes: Uint8Array): void {
  try {
    offer({ kind: "record", file: getBackupsDbPath(), sessionId: SESSION_ID, path: absolutePath,
      bytes, writtenAt: new Date().toISOString(), partSize });
  } catch (error) {
    logWarn("backup store: failed to capture a write", { file: absolutePath, error: serializeError(error) });
  }
}

/** Consumes a pinned installed-file descriptor; only its opening thread closes it after acknowledgement. */
export function recordFile(absolutePath: string, fd: number, sha256: string, size: number): void {
  try {
    offer({ kind: "record-file", file: getBackupsDbPath(), sessionId: SESSION_ID, path: absolutePath,
      fd, sha256, size, writtenAt: new Date().toISOString(), partSize });
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* Capture never acquired ownership. */ }
    logWarn("backup store: failed to capture a write", { file: absolutePath, error: serializeError(error) });
  }
}

function settle(boundMs: number, close: boolean): boolean {
  const owner = recorder;
  if (!owner) return true;
  const deadline = performance.now() + boundMs;
  try {
    if (!owner.queue.drain(boundMs)) return false;
    if (!close) return true;
    const signal = new Int32Array(new SharedArrayBuffer(4));
    owner.worker.postMessage({ kind: "close", signal } satisfies BackupWorkerRequest);
    return Atomics.wait(signal, 0, 0, Math.max(0, deadline - performance.now())) !== "timed-out";
  } catch (error) { disable(owner, error); return false; }
}

/** Waits within one overall bound for admitted writes, including those still pending locally. */
export function drainBackups(boundMs: number): boolean { return settle(boundMs, false); }

/** Drops pending work at OS shutdown; retains active handles until the worker actually exits. */
export function stopBackups(boundMs: number): Promise<void> {
  const owner = recorder;
  if (!owner) return retirement ?? Promise.resolve();
  if (boundMs > 0) settle(boundMs, true);
  recorder = null;
  owner.queue.abandonPending();
  retirement = owner.worker.terminate().then(() => { owner.queue.retired(); retirement = null; });
  return retirement;
}

/** Test roots may change only after outstanding writes and the database have closed. */
export function closeBackupStore(): void { settle(5000, true); }
