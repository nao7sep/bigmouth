import { Worker, MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import type { ContentSaveEvent } from "./core/services/postStore.js";
import type { StorageTasks } from "./storageTasks.js";
import { AssetRecordError } from "./core/services/assetStore.js";

export const STORAGE_WAIT_MS = 10_000;
export type StorageCommand = keyof StorageTasks;
export const isAuthored = (name: StorageCommand) => ["queueContent", "queueMetadata", "queueWorkspaceContent", "queueWorkspaceMetadata"].includes(name);
const isContent = (name: StorageCommand) => name === "queueContent" || name === "queueWorkspaceContent";
// Requests that must still reach the worker after their caller stops waiting:
// authored edits, and a cancelled quit's resumption of debounced writes.
const mustReachWorker = (name: StorageCommand) => isAuthored(name) || name === "resumePendingFlushes";
export interface StorageRequest { id: number; name: StorageCommand; args: unknown[] }
export interface StorageFinishRequest { finish: true; queued: StorageRequest[]; signal: Int32Array; port: MessagePort }
export interface StorageFlushRequest { flush: true; edits: StorageRequest[]; signal: Int32Array; port: MessagePort }
export type StorageReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { name: string; message: string; stack?: string; cause?: unknown; asset?: unknown } }
  | { event: "content-save"; value: ContentSaveEvent }
  | { event: "record-stored" }
  | { event: "flush-settled" };

export type StorageFlushOutcome =
  | { kind: "flushed"; failures: { id: string; message: string }[] }
  | { kind: "expired" }
  | { kind: "crashed"; error: string };

/**
 * An authored edit storage has not accepted yet: it arrived while storage was
 * settling a flush or an operation whose wait expired, or its own wait expired.
 * The edit is not lost. The owner holds it, keeps it in its queue position, or
 * the worker already has it, and it reaches the post store's buffer as soon as
 * storage takes work again.
 */
export class EditPendingError extends Error {
  constructor() {
    super("Storage has not accepted this edit yet; it is held and will be delivered.");
    this.name = "EditPendingError";
  }
}

interface Waiting {
  request: StorageRequest;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  expired: boolean;
}

// One post's held edits: its newest content, which replaces the whole text,
// and every metadata edit, each validated on its own as when it was typed.
interface HeldEdits { content?: StorageRequest; metadata: StorageRequest[] }

/**
 * The app's one storage owner (transaction-and-external-effect-conventions).
 *
 * Pending post edits have one owner at a time. Once the worker accepts an edit,
 * the post store's write-behind buffer owns it until it is written or reported
 * terminal. This owner holds only edits the worker has not accepted, by post,
 * and delivers them as soon as storage takes work again, so an edit typed while
 * storage is stalled is neither refused nor replayed after it saved. Edits are
 * held only as they arrive, so they keep their order against other requests.
 */
export class StorageOwner {
  private worker: Worker | null = null;
  private active: Waiting | null = null;
  private queued: Waiting[] = [];
  private sequence = 0;
  private failed = false;
  private flushing = false;
  private closing = false;
  // Requests taken out of the queue by a flush or finish, awaiting their replies.
  private delivering = new Map<number, Waiting>();
  private held = new Map<string, HeldEdits>();
  private contentListener: ((event: ContentSaveEvent) => void) | null = null;
  private flushSettled: (() => void) | null = null;
  private recordListener: (() => void) | null = null;
  private heldFailureListener: ((request: StorageRequest, failure: unknown) => void) | null = null;

  constructor(private readonly createWorker = () => {
    const module = import.meta.url.endsWith(".ts") ? "./storageWorker.ts" : "./storage-worker.js";
    return new Worker(new URL(module, import.meta.url));
  }) {}

  onContentSave(listener: ((event: ContentSaveEvent) => void) | null): void { this.contentListener = listener; }
  onRecordStored(listener: (() => void) | null): void { this.recordListener = listener; }
  /** A held edit the store refused or could not take once delivered: its caller has already been answered. */
  onHeldEditFailed(listener: ((request: StorageRequest, failure: unknown) => void) | null): void { this.heldFailureListener = listener; }

  run<K extends StorageCommand>(name: K, args: Parameters<StorageTasks[K]>, boundMs = STORAGE_WAIT_MS): Promise<ReturnType<StorageTasks[K]>> {
    const request: StorageRequest = { id: ++this.sequence, name, args: structuredClone(args) };
    if (this.closing) return Promise.reject(new Error("Storage is closing."));
    if (this.failed) return Promise.reject(new Error("Storage is unavailable while its previous operation settles."));
    if (name !== "resumePendingFlushes" && (this.flushing || this.active?.expired)) {
      if (!isAuthored(name)) return Promise.reject(new Error("Storage is unavailable while its previous operation settles."));
      this.hold(request);
      return Promise.reject(new EditPendingError());
    }
    return new Promise((resolve, reject) => {
      this.queued.push(this.wait(request, resolve as (value: unknown) => void, reject, boundMs));
      this.dispatch();
    });
  }

  private wait(request: StorageRequest, resolve: (value: unknown) => void, reject: (error: Error) => void, boundMs: number): Waiting {
    const waiting: Waiting = {
      request, resolve, reject, expired: false,
      timer: setTimeout(() => {
        waiting.expired = true;
        // Timeout ends the caller's wait. An active mutation still belongs to
        // this worker until its actual result settles; no successor runs. An
        // edit, or a cancelled quit's resumption, keeps its queue position so it
        // still runs in order; other queued work is dropped.
        if (!mustReachWorker(request.name)) this.queued = this.queued.filter((item) => item !== waiting);
        reject(isAuthored(request.name)
          ? new EditPendingError()
          : new Error("Storage did not finish within its wait bound. Its outcome is still pending."));
      }, boundMs),
    };
    return waiting;
  }

  private hold(request: StorageRequest): void {
    const key = JSON.stringify([request.args[0], request.args[1]]);
    const post = this.held.get(key) ?? { metadata: [] };
    if (isContent(request.name)) post.content = request;
    else post.metadata.push(request);
    this.held.set(key, post);
  }

  private takeHeld(): StorageRequest[] {
    const requests = [...this.held.values()].flatMap((post) => [...(post.content ? [post.content] : []), ...post.metadata]);
    this.held.clear();
    return requests.sort((a, b) => a.id - b.id);
  }

  // A held edit's own caller was answered when it was held, so its delivery
  // reports a failure to the listener instead of to anyone waiting.
  private delivery(request: StorageRequest): Waiting {
    return this.wait(request, (value) => {
      if (!isContent(request.name) && value !== null) this.heldFailureListener?.(request, value);
    }, (error) => {
      if (!(error instanceof EditPendingError)) this.heldFailureListener?.(request, error);
    }, STORAGE_WAIT_MS);
  }

  private undeliveredEdits(): boolean {
    return this.held.size > 0
      || this.queued.some((waiting) => isAuthored(waiting.request.name))
      || (this.active !== null && isAuthored(this.active.request.name));
  }

  private beginFlush() {
    if (!this.worker || this.failed) throw new Error("Storage is unavailable.");
    if (this.flushing) throw new Error("The previous storage flush is still running.");
    this.flushing = true;
    const queuedEdits = this.queued.filter((waiting) => isAuthored(waiting.request.name));
    this.queued = this.queued.filter((waiting) => !isAuthored(waiting.request.name));
    for (const waiting of queuedEdits) this.delivering.set(waiting.request.id, waiting);
    const edits = [...this.takeHeld(), ...queuedEdits.map((waiting) => waiting.request)].sort((a, b) => a.id - b.id);
    const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const { port1, port2 } = new MessageChannel();
    try {
      this.worker.postMessage({ flush: true, edits, signal, port: port2 } satisfies StorageFlushRequest, [port2]);
    } catch (error) {
      port1.close();
      port2.close();
      this.failed = true;
      this.failWaiting(error instanceof Error ? error : new Error("Storage flush could not start."));
      throw error;
    }
    return { port: port1, signal };
  }

  private async flushOnce(boundMs: number): Promise<StorageFlushOutcome> {
    try {
      let settled!: () => void;
      const settlement = new Promise<void>((resolve) => { settled = resolve; });
      const { port } = this.beginFlush();
      this.flushSettled = settled;
      return await new Promise<StorageFlushOutcome>((resolve) => {
        const timer = setTimeout(() => { port.close(); resolve({ kind: "expired" }); }, boundMs);
        port.once("message", async (reply: { failures: { id: string; message: string }[] }) => {
          await settlement;
          clearTimeout(timer);
          port.close();
          resolve({ kind: "flushed", failures: reply.failures });
        });
      });
    } catch (error) { return { kind: "crashed", error: error instanceof Error ? error.message : String(error) }; }
  }

  /** Flushes until no edit remains undelivered: edits arriving during a flush are held and written by the next. */
  async flushAsync(boundMs: number): Promise<StorageFlushOutcome> {
    const deadline = Date.now() + boundMs;
    for (;;) {
      const result = await this.flushOnce(Math.max(0, deadline - Date.now()));
      if (result.kind !== "flushed" || result.failures.length || !this.undeliveredEdits()) return result;
      if (Date.now() >= deadline) return { kind: "expired" };
    }
  }

  // Windows session-end cannot defer its return; ordinary quits use flushAsync.
  flushWithin(boundMs: number): StorageFlushOutcome {
    try {
      const { port, signal } = this.beginFlush();
      try {
        Atomics.wait(signal, 0, 0, boundMs);
        const reply = receiveMessageOnPort(port)?.message as { failures: { id: string; message: string }[] } | undefined;
        return reply ? { kind: "flushed", failures: reply.failures } : { kind: "expired" };
      } finally { port.close(); }
    } catch (error) { return { kind: "crashed", error: error instanceof Error ? error.message : String(error) }; }
  }

  private beginFinish() {
    if (!this.worker || this.failed) return null;
    this.closing = true;
    const queued = this.queued.splice(0);
    for (const waiting of queued) this.delivering.set(waiting.request.id, waiting);
    const requests = [...this.takeHeld(), ...queued.map((item) => item.request)].sort((a, b) => a.id - b.id);
    const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const { port1, port2 } = new MessageChannel();
    try {
      this.worker.postMessage({ finish: true, queued: requests, signal, port: port2 } satisfies StorageFinishRequest, [port2]);
    } catch (error) {
      port1.close();
      port2.close();
      this.failed = true;
      this.failWaiting(error instanceof Error ? error : new Error("Storage finish could not start."));
      throw error;
    }
    return { port: port1, signal };
  }

  /** Resolves true when the worker finished within the bound, false when it is still busy. */
  async finishAsync(boundMs: number): Promise<boolean> {
    const result = this.beginFinish();
    if (!result) return true;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { result.port.close(); resolve(false); }, boundMs);
      result.port.once("message", () => { clearTimeout(timer); result.port.close(); resolve(true); });
    });
  }

  /** Returns true when the worker finished within the bound, false when it is still busy. */
  finishWithin(boundMs: number): boolean {
    const result = this.beginFinish();
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
    if (this.active || this.failed || this.flushing || this.closing) return;
    // Held edits arrived while storage could take nothing, after everything
    // already queued, so they are delivered after it.
    if (this.held.size) this.queued.push(...this.takeHeld().map((request) => this.delivery(request)));
    const waiting = this.queued.shift();
    if (!waiting) return;
    this.active = waiting;
    try {
      if (!this.worker) {
        const worker = this.createWorker();
        this.worker = worker;
        worker.unref();
        worker.on("message", (reply: StorageReply) => this.receive(reply));
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
      if (reply.event === "record-stored") this.recordListener?.();
      else if (reply.event === "flush-settled") { this.flushing = false; this.flushSettled?.(); this.flushSettled = null; this.dispatch(); }
      else this.contentListener?.(reply.value);
      return;
    }
    const delivered = this.delivering.get(reply.id);
    const waiting = delivered ?? this.active;
    if (!waiting || reply.id !== waiting.request.id) return;
    clearTimeout(waiting.timer);
    if (delivered) this.delivering.delete(reply.id);
    else this.active = null;
    if (!waiting.expired) {
      if (reply.ok) waiting.resolve(reply.value);
      else {
        const data = reply.error;
        const error = data.name === "AssetRecordError" && data.asset
          ? new AssetRecordError(data.asset as ConstructorParameters<typeof AssetRecordError>[0], data.cause)
          : new Error(data.message, { cause: data.cause });
        error.name = data.name;
        error.stack = data.stack;
        waiting.reject(error);
      }
    }
    this.dispatch();
  }

  private failWaiting(error: Error): void {
    const waiting = [this.active, ...this.queued, ...this.delivering.values()];
    this.delivering.clear();
    this.active = null;
    this.queued = [];
    for (const item of waiting) {
      if (!item) continue;
      clearTimeout(item.timer);
      if (!item.expired) item.reject(error);
    }
  }
}

export const storageOwner = new StorageOwner();
