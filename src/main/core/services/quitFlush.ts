/**
 * The post flush at quit, with a bound (unsaved-edits-conventions, Quitting).
 *
 * The post store writes synchronously, and a synchronous write to a stalled
 * disk cannot be timed out on the thread that makes it. Windows' session end
 * also needs the flush finished before its handler returns, since the session
 * may end as soon as it does. So the quit copies the buffered edits to a worker
 * thread that runs the store's own flush on them, and this thread waits for its
 * answer for at most the bound, synchronously. A worker that has not answered
 * is terminated, so it writes nothing more once its current call returns.
 *
 * The edits stay buffered here whatever happens: a quit the user cancels keeps
 * them, and the store writes them again on its debounce, which changes nothing
 * on disk for an edit the worker already wrote.
 */

import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from "node:worker_threads";

import {
  announceContentSaveEvents,
  copyPendingEdits,
  type ContentSaveEvent,
  type PendingEditCopy,
} from "./postStore.js";
import { currentRecordsSession } from "./recordsStore.js";

/**
 * How long the quit waits for the posts to be written. With the shutdown steps
 * after it, it stays well inside the 5 s Windows allows an ending session.
 */
export const QUIT_FLUSH_BOUND_MS = 2000;

export type QuitFlushFailure = { id: string; message: string };

export type QuitFlushOutcome =
  /** Every edit was tried; `failures` lists those still only in memory. */
  | { kind: "flushed"; failures: QuitFlushFailure[] }
  /** The flush did not answer within the bound; what it wrote is unknown. */
  | { kind: "expired" }
  /** The flush could not run. */
  | { kind: "crashed"; error: string };

/** What the quit flush worker is given. */
export interface QuitFlushRequest {
  edits: PendingEditCopy[];
  /** The session the worker's log records join, or null when the records are not open. */
  recordsSession: string | null;
}

/** What the quit flush worker answers. */
export interface QuitFlushReply {
  failures: QuitFlushFailure[];
  events: ContentSaveEvent[];
}

/** Writes every buffered edit within `boundMs`, synchronously. */
export function flushPendingEditsWithin(boundMs = QUIT_FLUSH_BOUND_MS): QuitFlushOutcome {
  const edits = copyPendingEdits();
  if (edits.length === 0) return { kind: "flushed", failures: [] };
  const request: QuitFlushRequest = { edits, recordsSession: currentRecordsSession() };
  const result = runWorkerWithin<QuitFlushReply>(workerUrl(), request, boundMs);
  if (result.kind !== "answered") return result;
  announceContentSaveEvents(result.value.events);
  return { kind: "flushed", failures: result.value.failures };
}

// Tests run the source with Node's TypeScript stripping; the app runs
// electron-vite's quit-flush-worker.js entry beside index.js.
function workerUrl(): URL {
  const module = import.meta.url.endsWith(".ts") ? "./quitFlushWorker.ts" : "./quit-flush-worker.js";
  return new URL(module, import.meta.url);
}

/** What a worker started by runWorkerWithin receives as its workerData. */
export interface BoundedWorkerData<T> {
  request: T;
  /** Set to 1 and notified once the reply is posted. */
  signal: Int32Array;
  /** Where the one reply goes: `{ ok: true, value }` or `{ ok: false, error }`. */
  port: MessagePort;
}

export type BoundedWorkerReply = { ok: true; value: unknown } | { ok: false; error: string };

export type BoundedWorkerResult<V> =
  | { kind: "answered"; value: V }
  | { kind: "expired" }
  | { kind: "crashed"; error: string };

/**
 * Runs `url` as a worker with `request` and blocks this thread until it
 * replies or `boundMs` passes, then terminates it. A worker that fails to load
 * never replies, so it reads as expired.
 */
export function runWorkerWithin<V>(url: URL, request: unknown, boundMs: number): BoundedWorkerResult<V> {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const { port1, port2 } = new MessageChannel();
  let worker: Worker;
  try {
    worker = new Worker(url, {
      workerData: { request, signal, port: port2 } satisfies BoundedWorkerData<unknown>,
      transferList: [port2],
    });
  } catch (error: unknown) {
    port1.close();
    return { kind: "crashed", error: error instanceof Error ? error.message : String(error) };
  }
  worker.unref();
  // A worker that throws or fails to load sends no reply, which is all this
  // reads; its error event, raised after the wait, has nothing left to tell.
  worker.on("error", () => {});
  Atomics.wait(signal, 0, 0, boundMs);
  const reply = receiveMessageOnPort(port1)?.message as BoundedWorkerReply | undefined;
  port1.close();
  void worker.terminate();
  if (reply === undefined) return { kind: "expired" };
  return reply.ok ? { kind: "answered", value: reply.value as V } : { kind: "crashed", error: reply.error };
}
