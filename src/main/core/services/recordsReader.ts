/**
 * The records window's reads of records.sqlite3, run on one worker thread with a
 * read-only connection of its own for the process lifetime: node:sqlite has
 * only a synchronous API. Reads are answered in order and awaited without a
 * bound, since local storage gets no timeout (transaction-and-external-effect-
 * conventions); each reply is routed to its read by id.
 */

import { Worker } from "node:worker_threads";

import { WORKER_ENTRIES } from "../../builtEntries.js";
import type { RecordsRead, RecordsReadResults } from "./recordsQueries.js";
import type { RecordsReaderData, RecordsReaderRequest, RecordsReaderResponse } from "./recordsReaderWorker.js";

/**
 * How long the reader's connection waits on a lock the writer holds before the
 * read fails with SQLite's own busy error.
 */
export const RECORDS_BUSY_TIMEOUT_MS = 2000;

type Pending = {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
};

let databasePath: string | null = null;
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

export function initRecordsReader(path: string): void {
  databasePath = path;
}

/** Rejects every read still waiting and lets the thread go without waiting. Called at quit. */
export function closeRecordsReader(): void {
  const current = worker;
  worker = null;
  databasePath = null;
  // Its exit is no longer this reader's news.
  current?.removeAllListeners();
  failPending(new Error("The records reader closed."));
  void current?.terminate();
}

export function readRecords<R extends RecordsRead>(read: R): Promise<RecordsReadResults[R["op"]]> {
  if (databasePath === null) return Promise.reject(new Error("The records reader is not open."));
  const path = databasePath;
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolve as (value: never) => void, reject });
    try {
      ensureWorker(path).postMessage({ id, read } satisfies RecordsReaderRequest);
    } catch (error: unknown) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
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
    if (response.ok) read.resolve(response.value as never);
    else read.reject(new Error(response.error));
  });
  created.on("error", (error: Error) => failPending(error));
  // A thread that died answers nothing more; the next read opens its own.
  created.on("exit", (code) => {
    worker = null;
    failPending(new Error(`The records reader exited with code ${code}.`));
  });
  worker = created;
  return created;
}

function failPending(error: Error): void {
  const waiting = [...pending.values()];
  pending.clear();
  for (const read of waiting) read.reject(error);
}
