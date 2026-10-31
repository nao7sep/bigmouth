/**
 * The data-backup history (data-backup-conventions): `backups.sqlite3` directly under BigMouth's
 * storage root (`BIGMOUTH_DATA_DIR` or `~/.bigmouth`, resolved in one place by {@link getAppRoot}),
 * holding the last version of each protected file saved in each session. What is protected is decided
 * at each write boundary: post files, the workspace registry, both settings files and an attachment's
 * `assets.json` call {@link record} after their write lands, and an installed attachment calls
 * {@link recordFile}; view state, secrets and records never do. There is no capture at launch, on a timer or at exit, and no restore path.
 *
 * Recording runs on its own thread (backupWorker.ts), which applies every write in save order, so a slow
 * or locked store never holds up the save that called it or the storage work behind it. `record` sends
 * the thread a copy of the exact bytes written and returns; `recordFile` sends an installed attachment
 * the app never held whole, to be read from disk. Failures are the thread's to report: one warn, never a
 * failed save. At an ordinary quit the pending writes draw on the exit deadline; at OS session end they
 * are skipped.
 *
 * SQLite binding: Node's built-in `node:sqlite`, which needs no native rebuild against Electron's Node ABI.
 */

import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { getBackupsDbPath } from "./storagePaths.js";
import { formatUtcIso } from "../shared/timestamps.js";
import { WRITER } from "../shared/storeFormat.js";
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

// The writes sent and not yet applied, in send order; the thread answers each in turn.
interface Recorder { worker: Worker; inFlight: BackupWrite[] }
// One recorder for the storage worker's lifetime, started at the first protected write.
let recorder: Recorder | null = null;
// The recorder failing to start or dying is reported once; recording then stays off.
let recorderFailed = false;

function release(write: BackupWrite): void {
  if (write.kind === "record-file") {
    try { fs.closeSync(write.fd); } catch { /* The descriptor has nothing left to protect. */ }
  }
}

// Lets the recorder go: what it has not applied is dropped, and its exit is no longer news.
// Its messages still arrive, so a warning it sent before going is logged.
function letGo(owner: Recorder): Promise<number> {
  recorder = null;
  for (const event of ["exit", "error", "messageerror"]) owner.worker.removeAllListeners(event);
  for (const write of owner.inFlight.splice(0)) release(write);
  return owner.worker.terminate();
}

function disable(error: unknown): void {
  const owner = recorder;
  if (!owner) return;
  recorderFailed = true;
  void letGo(owner);
  logWarn("backup recorder stopped; recording disabled for this session", { error: serializeError(error) });
}

function ensureRecorder(): Recorder | null {
  if (recorder) return recorder;
  if (recorderFailed) return null;
  try {
    if (!recorderModule) throw new Error("The backup recorder's module is not known.");
    const worker = new Worker(recorderModule, { workerData: { writer: WRITER } });
    worker.unref();
    const owner: Recorder = { worker, inFlight: [] };
    // The thread applied the oldest write it was sent; a descriptor is closed on this thread, which opened it.
    worker.on("message", (notice: BackupWorkerNotice) => {
      if (notice.kind === "warn") logWarn(notice.text, notice.fields);
      else {
        const write = owner.inFlight.shift();
        if (write) release(write);
      }
    });
    worker.on("messageerror", disable);
    worker.on("error", disable);
    worker.on("exit", (code) => disable(new Error(`The backup recorder exited with code ${code}.`)));
    recorder = owner;
  } catch (error) {
    recorderFailed = true;
    logWarn("backup recorder could not start; recording disabled for this session", { error: serializeError(error) });
  }
  return recorder;
}

function offer(write: BackupWrite): void {
  const owner = ensureRecorder();
  if (!owner) { release(write); return; }
  // The caller keeps its bytes: the thread is handed a copy of its own.
  const sent = write.kind === "record" ? { ...write, bytes: new Uint8Array(write.bytes) } : write;
  try {
    owner.worker.postMessage(sent satisfies BackupWorkerRequest, sent.kind === "record" ? [sent.bytes.buffer as ArrayBuffer] : []);
    owner.inFlight.push(sent);
  }
  catch (error) { release(sent); disable(error); }
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
 * Ends recording for the process. With `drain`, as at an ordinary quit, this thread waits until every
 * pending write is applied and the store file released; without it, as at OS session end, they are
 * skipped. Resolves once the recorder has stopped, which one blocked inside SQLite does only when that
 * call returns: Electron's exit would wait for it, so the quit's exit deadline bounds this wait too.
 */
export async function stopBackups(drain: boolean): Promise<void> {
  const owner = recorder;
  if (!owner) return;
  let stopped: Promise<number>;
  try {
    if (drain) {
      const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      owner.worker.postMessage({ kind: "close", signal } satisfies BackupWorkerRequest);
      Atomics.wait(signal, 0, 0);
    }
  } finally { stopped = letGo(owner); }
  await stopped;
}
