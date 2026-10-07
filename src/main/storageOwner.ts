import { Worker, MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import type { ContentSaveEvent } from "./core/services/postStore.js";
import type { StorageTasks } from "./storageTasks.js";
import { AssetRecordError } from "./core/services/assetStore.js";

export const STORAGE_WAIT_MS = 10_000;
export type StorageCommand = keyof StorageTasks;
export const isAuthored = (name: StorageCommand) => ["queueContent", "queueMetadata", "queueWorkspaceContent", "queueWorkspaceMetadata"].includes(name);
export interface StorageRequest { id: number; name: StorageCommand; args: unknown[]; edits?: StorageRequest[] }
export interface StorageFinishRequest { finish: true; queued: StorageRequest[]; signal: Int32Array; port: MessagePort }
export interface StorageFlushRequest { flush: true; edits: StorageRequest[]; signal: Int32Array; port: MessagePort }
export type StorageReply =
  | { id: number; ok: true; value: unknown; dataDir?: string }
  | { id: number; ok: false; error: { name: string; message: string; stack?: string; cause?: unknown; asset?: unknown } }
  | { event: "content-save"; value: ContentSaveEvent; sequence: number }
  | { event: "record-stored" }
  | { event: "flush-settled" };

export type StorageFlushOutcome =
  | { kind: "flushed"; failures: { id: string; message: string }[] }
  | { kind: "expired" }
  | { kind: "crashed"; error: string };

interface Waiting {
  request: StorageRequest;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  expired: boolean;
}

/** The app's one storage owner (transaction-and-external-effect-conventions). */
export class StorageOwner {
  private worker: Worker | null = null;
  private active: Waiting | null = null;
  private queued: Waiting[] = [];
  private sequence = 0;
  private failed = false;
  private flushing = false;
  private closing = false;
  private replayed = new Map<number, Waiting>();
  private edits = new Map<number, StorageRequest>();
  private contentListener: ((event: ContentSaveEvent) => void) | null = null;
  private flushSettled: (() => void) | null = null;
  private recordListener: (() => void) | null = null;

  constructor(private readonly createWorker = () => {
    const module = import.meta.url.endsWith(".ts") ? "./storageWorker.ts" : "./storage-worker.js";
    return new Worker(new URL(module, import.meta.url));
  }) {}

  onContentSave(listener: ((event: ContentSaveEvent) => void) | null): void { this.contentListener = listener; }
  onRecordStored(listener: (() => void) | null): void { this.recordListener = listener; }

  run<K extends StorageCommand>(name: K, args: Parameters<StorageTasks[K]>, boundMs = STORAGE_WAIT_MS): Promise<ReturnType<StorageTasks[K]>> {
    const request: StorageRequest = { id: ++this.sequence, name, args: structuredClone(args) };
    if (this.closing) return Promise.reject(new Error("Storage is closing."));
    if (isAuthored(name)) this.edits.set(request.id, request);
    if (name === "resumePendingFlushes") request.edits = [...this.edits.values()];
    if (this.failed || this.closing || (name !== "resumePendingFlushes" && (this.flushing || this.active?.expired))) return Promise.reject(new Error("Storage is unavailable while its previous operation settles."));
    return new Promise((resolve, reject) => {
      const waiting: Waiting = {
        request, resolve: resolve as (value: unknown) => void, reject, expired: false,
        timer: setTimeout(() => {
          waiting.expired = true;
          // Timeout ends the caller's wait. An active mutation still belongs to
          // this worker until its actual result settles; no successor runs.
          if (this.active !== waiting) this.queued = this.queued.filter((item) => item !== waiting);
          reject(new Error("Storage did not finish within its wait bound. Its outcome is still pending."));
        }, boundMs),
      };
      this.queued.push(waiting);
      this.dispatch();
    });
  }

  private beginFlush() {
    if (!this.worker || this.failed) throw new Error("Storage is unavailable.");
    if (this.flushing) throw new Error("The previous storage flush is still running.");
    this.flushing = true;
    for (const waiting of this.queued) {
      if (isAuthored(waiting.request.name)) this.replayed.set(waiting.request.id, waiting);
    }
    this.queued = this.queued.filter((waiting) => !this.replayed.has(waiting.request.id));
    const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const { port1, port2 } = new MessageChannel();
    try {
      this.worker.postMessage({ flush: true, edits: [...this.edits.values()], signal, port: port2 } satisfies StorageFlushRequest, [port2]);
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

  async flushAsync(boundMs: number): Promise<StorageFlushOutcome> {
    const deadline = Date.now() + boundMs;
    for (;;) {
      const result = await this.flushOnce(Math.max(0, deadline - Date.now()));
      if (result.kind !== "flushed" || result.failures.length || !this.edits.size) return result;
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
    for (const waiting of queued) this.replayed.set(waiting.request.id, waiting);
    const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const { port1, port2 } = new MessageChannel();
    try {
      this.worker.postMessage({ finish: true, queued: queued.map((item) => item.request), signal, port: port2 } satisfies StorageFinishRequest, [port2]);
    } catch (error) {
      port1.close();
      port2.close();
      this.failed = true;
      this.failWaiting(error instanceof Error ? error : new Error("Storage finish could not start."));
      throw error;
    }
    return { port: port1, signal };
  }

  async finishAsync(boundMs: number): Promise<void> {
    const result = this.beginFinish();
    if (!result) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { result.port.close(); resolve(); }, boundMs);
      result.port.once("message", () => { clearTimeout(timer); result.port.close(); resolve(); });
    });
  }

  finishWithin(boundMs: number): void {
    const result = this.beginFinish();
    if (!result) return;
    try { Atomics.wait(result.signal, 0, 0, boundMs); } finally { result.port.close(); }
  }

  pendingEditIds(): string[] { return [...new Set([...this.edits.values()].map((item) => String(item.args[1])))]; }

  async stop(): Promise<void> {
    this.failed = true;
    const worker = this.worker;
    this.worker = null;
    this.failWaiting(new Error("Storage stopped."));
    await worker?.terminate();
  }

  private dispatch(): void {
    if (this.active || this.failed || this.flushing || this.closing) return;
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
      else {
        if (reply.value.kind === "saved") {
          for (const [id, request] of this.edits) {
            if (id <= reply.sequence && request.args[0] === reply.value.dataDir && request.args[1] === reply.value.id) this.edits.delete(id);
          }
        }
        this.contentListener?.(reply.value);
      }
      return;
    }
    const edit = this.edits.get(reply.id);
    if (edit && reply.ok && reply.dataDir) {
      edit.args[0] = reply.dataDir;
      if (edit.name === "queueWorkspaceContent") edit.name = "queueContent";
      if (edit.name === "queueWorkspaceMetadata") edit.name = "queueMetadata";
    }
    if (edit?.name === "queueMetadata" && reply.ok && reply.value !== null) this.edits.delete(reply.id);
    const replayed = this.replayed.get(reply.id);
    const waiting = replayed ?? this.active;
    if (!waiting || reply.id !== waiting.request.id) return;
    clearTimeout(waiting.timer);
    if (replayed) this.replayed.delete(reply.id);
    else this.active = null;
    if (waiting.request.name === "queueMetadata" && reply.ok && reply.value !== null) this.edits.delete(reply.id);
    if (waiting.request.name === "deletePost" && reply.ok && reply.value === true) {
      for (const [id, request] of this.edits) {
        if (request.args[0] === waiting.request.args[0] && request.args[1] === waiting.request.args[1]) this.edits.delete(id);
      }
    }
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
    const waiting = [this.active, ...this.queued, ...this.replayed.values()];
    this.replayed.clear();
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
