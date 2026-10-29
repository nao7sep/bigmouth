import { Worker, MessageChannel, type MessagePort } from "node:worker_threads";
import type { RecordsHealth } from "@shared/records";
import type { ContentSaveEvent } from "./core/services/postStore.js";
import type { StorageTasks } from "./storageTasks.js";
import { DEBUG_LOG_FLAG } from "./core/services/logger.js";
import { WORKER_ENTRIES } from "./builtEntries.js";

export type StorageCommand = keyof StorageTasks;
export interface StorageRequest { id: number; name: StorageCommand; args: unknown[] }
export interface StorageFinishRequest { finish: true; queued: StorageRequest[]; drainBackups: boolean; signal: Int32Array; port: MessagePort }
export type WorkspaceContentSaveEvent = ContentSaveEvent & { wsId: string };
export type StorageReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { name: string; message: string; stack?: string; cause?: unknown } }
  | { event: "content-save"; value: WorkspaceContentSaveEvent }
  | { event: "record-stored" }
  | { event: "records-health"; value: RecordsHealth }
  // The worker could not read a request it was sent, so it never ran it.
  | { event: "request-unreadable" };

interface Waiting {
  request: StorageRequest;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * The app's one storage owner (transaction-and-external-effect-conventions).
 *
 * One worker thread runs every storage command, one at a time, in the order
 * they arrive; node:sqlite and the stores' synchronous file code need a thread
 * of their own. A command waits its turn and its caller waits for its result:
 * local storage has no deadline, so a stalled volume holds storage until the
 * operating system returns, and only the exit sequence's own deadline bounds
 * the quit. Once the worker accepts a post edit, the post store's write-behind
 * buffer owns it until it is written or reported terminal.
 */
export class StorageOwner {
  private worker: Worker | null = null;
  // Sent to the worker and awaiting its reply, by request id, oldest first:
  // one request at a time, except that finishing sends everything still queued.
  private sent = new Map<number, Waiting>();
  private queued: Waiting[] = [];
  private sequence = 0;
  private failed = false;
  private closing = false;
  private contentListener: ((event: WorkspaceContentSaveEvent) => void) | null = null;
  private recordsHealthValue: RecordsHealth = { databaseGap: false, fallbackFailed: false, fallbackPath: null };
  private recordsHealthListener: ((health: RecordsHealth) => void) | null = null;
  private recordListener: (() => void) | null = null;

  constructor(private readonly createWorker = () => {
    const module = import.meta.url.endsWith(".ts") ? "./storageWorker.ts" : `./${WORKER_ENTRIES.storage}.js`;
    // The records are written on the worker, so it reads the debug switch there:
    // a worker sees only the arguments it is given, never the app's own.
    return new Worker(new URL(module, import.meta.url), { argv: process.argv.filter((arg) => arg === DEBUG_LOG_FLAG) });
  }) {}

  onContentSave(listener: ((event: WorkspaceContentSaveEvent) => void) | null): void { this.contentListener = listener; }
  recordsHealth(): RecordsHealth { return { ...this.recordsHealthValue }; }
  onRecordsHealth(listener: ((health: RecordsHealth) => void) | null): void { this.recordsHealthListener = listener; }
  onRecordStored(listener: (() => void) | null): void { this.recordListener = listener; }

  run<K extends StorageCommand>(name: K, args: Parameters<StorageTasks[K]>): Promise<ReturnType<StorageTasks[K]>> {
    if (this.closing) return Promise.reject(new Error("Storage is closing."));
    if (this.failed) return Promise.reject(new Error("Storage is unavailable."));
    const request: StorageRequest = { id: ++this.sequence, name, args: structuredClone(args) };
    return new Promise((resolve, reject) => {
      this.queued.push({ request, resolve: resolve as (value: unknown) => void, reject });
      this.dispatch();
    });
  }

  private beginFinish(drainBackups: boolean) {
    if (!this.worker || this.failed) return null;
    this.closing = true;
    // The worker runs messages in order, so what is still queued runs after the
    // request it is working on and before the finish itself.
    const queued = this.queued.splice(0);
    for (const waiting of queued) this.sent.set(waiting.request.id, waiting);
    const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const { port1, port2 } = new MessageChannel();
    try {
      this.worker.postMessage({ finish: true, queued: queued.map((item) => item.request), drainBackups, signal, port: port2 } satisfies StorageFinishRequest, [port2]);
    } catch (error) {
      port1.close();
      port2.close();
      this.failed = true;
      this.failWaiting(error instanceof Error ? error : new Error("Storage finish could not start."));
      throw error;
    }
    return { port: port1, signal };
  }

  /**
   * Ends storage for the process: the worker runs what is queued, writes the buffered post edits
   * and closes its stores. Resolves true when it finished within `boundMs`, false when it is still
   * busy. Pending backup writes are applied within that bound with `drainBackups`, and skipped without.
   */
  async finishAsync(boundMs: number, drainBackups: boolean): Promise<boolean> {
    const result = this.beginFinish(drainBackups);
    if (!result) return true;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { result.port.close(); resolve(false); }, boundMs);
      result.port.once("message", () => { clearTimeout(timer); result.port.close(); resolve(true); });
    });
  }

  /**
   * As finishAsync, waiting on this thread: Windows ends the process as soon as its session-end
   * handler returns, so that handler cannot await. Pending backup writes are skipped.
   */
  finishWithin(boundMs: number): boolean {
    const result = this.beginFinish(false);
    if (!result) return true;
    try { return Atomics.wait(result.signal, 0, 0, boundMs) !== "timed-out"; } finally { result.port.close(); }
  }

  async stop(): Promise<void> {
    this.failed = true;
    const worker = this.worker;
    this.worker = null;
    this.failWaiting(new Error("Storage stopped."));
    await worker?.terminate();
  }

  private dispatch(): void {
    if (this.sent.size > 0 || this.failed || this.closing) return;
    const waiting = this.queued.shift();
    if (!waiting) return;
    this.sent.set(waiting.request.id, waiting);
    try {
      if (!this.worker) {
        const worker = this.createWorker();
        this.worker = worker;
        worker.unref();
        worker.on("message", (reply: StorageReply) => this.receive(reply));
        // A reply the worker sent that could not be read here would otherwise
        // leave its request waiting forever. The oldest request sent is the one
        // the worker answers next; it fails with its outcome unknown rather
        // than as undone.
        worker.on("messageerror", (error) => this.loseOldest(new Error(
          "Storage could not return this operation's result. Whether it took effect is unknown.",
          { cause: error },
        )));
        worker.on("error", (error) => { this.failed = true; this.failWaiting(error instanceof Error ? error : new Error("Storage worker failed.", { cause: error })); });
        worker.on("exit", () => {
          if (this.worker !== worker) return;
          this.failed = true;
          this.failWaiting(new Error("The storage worker exited."));
        });
      }
      this.worker.postMessage(waiting.request);
    } catch (error) {
      this.failed = true;
      this.failWaiting(error instanceof Error ? error : new Error("Storage could not start."));
    }
  }

  private receive(reply: StorageReply): void {
    if ("event" in reply) {
      if (reply.event === "records-health") {
        this.recordsHealthValue = reply.value;
        this.recordsHealthListener?.({ ...reply.value });
      }
      else if (reply.event === "record-stored") this.recordListener?.();
      else if (reply.event === "request-unreadable") this.loseOldest(new Error("Storage could not read this request. Nothing was done."));
      else this.contentListener?.(reply.value);
      return;
    }
    const waiting = this.sent.get(reply.id);
    if (!waiting) return;
    this.sent.delete(reply.id);
    if (reply.ok) waiting.resolve(reply.value);
    else {
      const data = reply.error;
      const error = new Error(data.message, { cause: data.cause });
      error.name = data.name;
      error.stack = data.stack;
      waiting.reject(error);
    }
    this.dispatch();
  }

  /** Fails the oldest request sent, whose reply will not arrive, and moves on to the next. */
  private loseOldest(error: Error): void {
    const oldest = this.sent.entries().next().value;
    if (!oldest) return;
    this.sent.delete(oldest[0]);
    oldest[1].reject(error);
    this.dispatch();
  }

  private failWaiting(error: Error): void {
    const waiting = [...this.sent.values(), ...this.queued];
    this.sent.clear();
    this.queued = [];
    for (const item of waiting) item.reject(error);
  }
}

export const storageOwner = new StorageOwner();
