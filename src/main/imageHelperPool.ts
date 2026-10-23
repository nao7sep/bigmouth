import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { WORKER_ENTRIES } from "./builtEntries.js";
import { StorageAdmission } from "./storageAdmission.js";
import type { DerivativeOutcome } from "./imageGeneration.js";
import { warn, serializeError } from "./core/services/logger.js";

export const IMAGE_IDLE_MS = 30_000;
export interface ImageJob {
  sourcePath: string; expectedHash: string; dir: string; workspaceRoot: string;
  stageDirectory: string; threads: number;
}
export type ImageHelperReply = { type: "progress" } | { type: "stage-created" } | { type: "result"; outcome: DerivativeOutcome };
export type ImagePoolOutcome = DerivativeOutcome | { kind: "busy" };
export interface ImageProcess {
  on(event: "message", listener: (reply: ImageHelperReply) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  on(event: "error", listener: (...args: unknown[]) => void): unknown;
  postMessage(job: ImageJob | { type: "retire" }): void;
  kill(): boolean;
}
export interface ImagePoolOptions {
  capacity?: number;
  create?: () => ImageProcess;
  cleanup?: (directory: string) => Promise<void>;
  pendingBytes?: number;
}
interface Request {
  id: number; workspace: string; foreground: boolean; job: ImageJob;
  resolve: (outcome: ImagePoolOutcome) => void; timer: ReturnType<typeof setTimeout>;
}
interface Active { request: Request; child: ImageProcess; stopped: boolean; ownsStage: boolean; result: DerivativeOutcome | null }

/** Process slots survive caller timeout until their particular helper has exited. */
export class ImageHelperPool {
  private readonly capacity: number;
  private readonly create: () => ImageProcess;
  private readonly cleanup: (directory: string) => Promise<void>;
  private readonly admission: StorageAdmission;
  private readonly queue: Request[] = [];
  private readonly active = new Set<Active>();
  private readonly quarantined = new Set<string>();
  private sequence = 0;
  private closed = false;

  constructor(options: ImagePoolOptions = {}) {
    // Two slots preserve a healthy foreground lane beside one stalled origin;
    // beyond that, each decoder gets a core and a modest native-memory share.
    this.capacity = options.capacity ?? Math.max(2, Math.min(os.availableParallelism(), Math.floor(os.totalmem() / (512 * 1024 * 1024))));
    this.admission = new StorageAdmission(options.pendingBytes ?? Math.floor(os.totalmem() / 4096));
    this.cleanup = options.cleanup ?? ((directory) => fsp.rm(directory, { recursive: true, force: true }));
    this.create = options.create ?? (() => {
      const { utilityProcess } = createRequire(import.meta.url)("electron") as typeof import("electron");
      return utilityProcess.fork(fileURLToPath(new URL(`./${WORKER_ENTRIES.image}.js`, import.meta.url)), [], { serviceName: "BigMouth image" });
    });
  }

  generate(workspace: string, sourcePath: string, expectedHash: string, dir: string, workspaceRoot: string, foreground: boolean): Promise<ImagePoolOutcome> {
    if (this.closed || this.quarantined.has(workspace)) return Promise.resolve({ kind: "busy" });
    const id = ++this.sequence;
    const job: ImageJob = { sourcePath, expectedHash, dir, workspaceRoot,
      stageDirectory: path.join(dir, `.image-${randomUUID()}`), threads: Math.max(1, Math.floor(os.availableParallelism() / this.capacity)) };
    if (!this.admission.reserve(id, [workspace, job])) return Promise.resolve({ kind: "busy" });
    return new Promise((resolve) => {
      const request: Request = { id, workspace, foreground, job, resolve, timer: setTimeout(() => this.drop(request), IMAGE_IDLE_MS) };
      request.timer.unref();
      this.queue.push(request);
      this.dispatch();
    });
  }

  private drop(request: Request): void {
    const index = this.queue.indexOf(request);
    if (index < 0) return;
    this.queue.splice(index, 1);
    clearTimeout(request.timer);
    this.admission.release(request.id);
    request.resolve({ kind: "busy" });
  }

  /** A now-visible image may use the slot reserved from speculative preparation. */
  promote(hash: string): void {
    for (const request of this.queue) if (request.job.expectedHash === hash) request.foreground = true;
    this.dispatch();
  }

  private dispatch(): void {
    if (this.closed) return;
    while (this.active.size < this.capacity) {
      const eligible = (request: Request) => ![...this.active].some((active) => active.request.workspace === request.workspace)
        && (request.foreground || this.active.size < this.capacity - 1);
      let index = this.queue.findIndex((request) => request.foreground && eligible(request));
      if (index < 0) index = this.queue.findIndex(eligible);
      if (index < 0) return;
      const request = this.queue.splice(index, 1)[0];
      clearTimeout(request.timer);
      let child: ImageProcess;
      try { child = this.create(); }
      catch (error) { this.admission.release(request.id); request.resolve({ kind: "failed", error }); continue; }
      const active: Active = { request, child, stopped: false, ownsStage: false, result: null };
      this.active.add(active);
      const progress = () => {
        if (active.stopped) return;
        clearTimeout(request.timer);
        request.timer = setTimeout(() => this.stopActive(active, new Error("Image processing stopped making progress.")), IMAGE_IDLE_MS);
        request.timer.unref();
      };
      child.on("message", (reply) => {
        if (reply.type === "stage-created") { active.ownsStage = true; progress(); return; }
        if (active.stopped || active.result) return;
        progress();
        if (reply.type === "result") {
          active.result = reply.outcome;
          request.resolve(reply.outcome);
          try { child.postMessage({ type: "retire" }); }
          catch (error) { this.stopActive(active, error); }
        }
      });
      child.on("error", (...error) => this.stopActive(active, new Error(`Image helper failed: ${String(error[0])}`)));
      child.on("exit", (code) => {
        clearTimeout(request.timer);
        if (!active.result && !active.stopped) request.resolve({ kind: "failed", error: new Error(`Image helper exited without a result (${code}).`) });
        active.stopped = true;
        // Native writes ended before the private directory can be removed.
        // Keep its slot through cleanup too, so a stalled cache cannot accumulate
        // unbounded abandoned cleanup operations.
        void (active.ownsStage ? this.cleanup(request.job.stageDirectory) : Promise.resolve()).catch((error: unknown) => {
          warn("image processing stage could not be removed", { path: request.job.stageDirectory, error: serializeError(error) });
        }).finally(() => {
          this.active.delete(active);
          this.quarantined.delete(request.workspace);
          this.admission.release(request.id);
          this.dispatch();
        });
      });
      progress();
      try { child.postMessage(request.job); }
      catch (error) { this.stopActive(active, error); }
    }
  }

  private stopActive(active: Active, error: unknown): void {
    if (active.stopped) return;
    active.stopped = true;
    clearTimeout(active.request.timer);
    this.quarantined.add(active.request.workspace);
    if (!active.result) active.request.resolve({ kind: "failed", error });
    for (const request of [...this.queue]) if (request.workspace === active.request.workspace) this.drop(request);
    // This exact child was created by this pool. kill's return is not proof of
    // retirement: only its exit event releases the occupied slot.
    try { active.child.kill(); }
    catch (failure) { warn("image helper could not be stopped", { error: serializeError(failure) }); }
  }

  stop(): void {
    this.closed = true;
    for (const request of [...this.queue]) this.drop(request);
    for (const active of this.active) this.stopActive(active, new Error("Image processing is closing."));
  }
}
