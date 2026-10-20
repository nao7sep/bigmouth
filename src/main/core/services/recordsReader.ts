/**
 * The records window's reads of records.sqlite3, run on a worker thread with a
 * read-only connection of its own (PLAYBOOK, Own the work in flight; Bound
 * every external wait). A read that does not answer in time is rejected, and
 * the thread it ran on is abandoned so the next read starts on a fresh one.
 */

import { Worker } from "node:worker_threads";

import { WORKER_ENTRIES } from "../../builtEntries.js";
import type { RecordsRead, RecordsReadResults } from "./recordsQueries.js";
import type { RecordsReaderData, RecordsReaderRequest, RecordsReaderResponse } from "./recordsReaderWorker.js";

export const RECORDS_READ_TIMEOUT_MS = 10_000;

/**
 * How long the reader's connection waits on a lock the writer holds. Well
 * inside the read timeout, so a lock that outlasts it fails the read with
 * SQLite's own busy error on a thread that stays usable, instead of the read
 * timing out and the thread being abandoned.
 */
export const RECORDS_BUSY_TIMEOUT_MS = RECORDS_READ_TIMEOUT_MS / 5;

type Pending = {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let databasePath: string | null = null;
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

export function initRecordsReader(path: string): void {
  databasePath = path;
}

/** Rejects every read still waiting and lets the thread go. Called at quit. */
export function closeRecordsReader(): void {
  abandon(new Error("The records reader closed."));
  databasePath = null;
}

export function readRecords<R extends RecordsRead>(read: R): Promise<RecordsReadResults[R["op"]]> {
  if (databasePath === null) return Promise.reject(new Error("The records reader is not open."));
  const path = databasePath;
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(
      () => abandon(new Error(`The records read did not answer within ${RECORDS_READ_TIMEOUT_MS} ms.`)),
      RECORDS_READ_TIMEOUT_MS,
    );
    pending.set(id, { resolve: resolve as (value: never) => void, reject, timer });
    try {
      ensureWorker(path).postMessage({ id, read } satisfies RecordsReaderRequest);
    } catch (error: unknown) {
      abandon(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function ensureWorker(path: string): Worker {
  if (worker !== null) return worker;
  // Tests run the source with Node's TypeScript stripping; the app runs
  // worker entry electron-vite builds beside index.js.
  const module = import.meta.url.endsWith(".ts") ? "./recordsReaderWorker.ts" : `./${WORKER_ENTRIES.recordsReader}.js`;
  const created = new Worker(new URL(module, import.meta.url), {
    workerData: { databasePath: path, busyTimeoutMs: RECORDS_BUSY_TIMEOUT_MS } satisfies RecordsReaderData,
  });
  created.unref();
  created.on("message", (response: RecordsReaderResponse) => {
    const read = pending.get(response.id);
    if (read === undefined) return;
    pending.delete(response.id);
    clearTimeout(read.timer);
    if (response.ok) read.resolve(response.value as never);
    else read.reject(new Error(response.error));
  });
  created.on("error", (error: Error) => {
    if (worker === created) abandon(error);
  });
  created.on("exit", (code) => {
    if (worker === created) abandon(new Error(`The records reader exited with code ${code}.`));
  });
  worker = created;
  return created;
}

function abandon(error: Error): void {
  const current = worker;
  worker = null;
  const waiting = [...pending.values()];
  pending.clear();
  for (const read of waiting) {
    clearTimeout(read.timer);
    read.reject(error);
  }
  void current?.terminate();
}
