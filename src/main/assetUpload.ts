/**
 * Receiving an upload's bytes in the main process.
 *
 * The renderer streams a picked file over its own MessagePort in slices of at most
 * ASSET_UPLOAD_SLICE_BYTES, sending the next only when main asks for it (see
 * AssetUploadToMain), and main writes each slice to a staged file in the workspace,
 * hashing it as it goes. An upload of any size therefore holds only a few slices
 * in either process, and the bytes are never sent as a whole through IPC, the
 * storage queue or the backup recorder. Main never copies a file the renderer
 * names by path: the renderer is untrusted, and only bytes it sends arrive.
 *
 * Staging is the upload's own private work, so it is written here with async
 * file I/O, off the storage worker's queue, which a long upload would otherwise
 * hold up; the storage worker publishes it (assetStore.installAsset). The staged
 * file is this module's until the upload settles: every path that does not
 * install it removes it, after its last write has finished (storage-path-
 * conventions), and one a crash leaves is cleared when the workspace next opens
 * (assetStore.sweepStaging).
 */

import { createHash, type Hash } from "node:crypto";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";

import {
  ASSET_UPLOAD_SLICE_BYTES,
  ASSET_UPLOAD_IDLE_MS,
  ASSET_UPLOAD_SLICES_IN_FLIGHT,
  type AssetUploadFromMain,
  type WorkspaceWriteProblem,
} from "@shared/ipc";
import type { StagedUpload } from "./core/services/assetStore.js";
import { workspaceWriteProblem } from "./core/shared/writeProblem.js";

/** A file being staged: its bytes are written, hashed and counted as they arrive. */
export class StagingFile {
  private bytes = 0;
  private readonly hash: Hash = createHash("sha256");
  private handle: FileHandle | null;

  private constructor(readonly path: string, handle: FileHandle) {
    this.handle = handle;
  }

  /**
   * Claims a new staged file in `dir`, creating the folder when needed. The file
   * is created exclusively, so it never takes over another writer's, and private
   * to the user while its bytes are written.
   */
  static async create(dir: string): Promise<StagingFile> {
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${nanoid()}.part`);
    return new StagingFile(file, await fsp.open(file, "wx", 0o600));
  }

  async write(data: Uint8Array): Promise<void> {
    const handle = this.handle;
    if (!handle) throw new Error("The staged upload is closed.");
    for (let offset = 0; offset < data.byteLength;) {
      const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset);
      if (bytesWritten === 0) throw new Error("The staged upload write made no progress.");
      offset += bytesWritten;
    }
    // Hashed after the write lands, so the hash describes exactly the bytes on disk.
    this.hash.update(data);
    this.bytes += data.byteLength;
  }

  /** Closes the file and describes what it holds, for installAsset. */
  async finish(): Promise<StagedUpload> {
    const handle = this.handle;
    if (!handle) throw new Error("The staged upload is closed.");
    this.handle = null;
    await handle.close();
    return { name: path.basename(this.path), sha256: this.hash.digest("hex"), size: this.bytes };
  }

  /**
   * Removes the staged file, if it is still there; one that was installed has
   * already been renamed away. Never throws: a stage that cannot be removed is
   * cleared when the workspace next opens.
   */
  async discard(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    try { await handle?.close(); } catch { /* Removal follows regardless. */ }
    try { await fsp.rm(this.path, { force: true }); } catch { /* Swept at the next open. */ }
  }
}

/** The part of Electron's MessagePortMain an upload uses, so tests can drive it with a Node port. */
export interface UploadPort {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  postMessage(message: AssetUploadFromMain): void;
  start(): void;
}

export type UploadStopReason = "abandoned" | "stalled";

/** Observe abandonment before any asynchronous preflight and bound upload inactivity. */
export class UploadLifetime {
  readonly stopped: Promise<UploadStopReason>;
  private resolveStopped!: (reason: UploadStopReason) => void;
  private stoppedReason: UploadStopReason | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private installing = false;
  private disposed = false;
  private readonly listeners = new Set<(reason: UploadStopReason) => void>();

  constructor(port: UploadPort) {
    this.stopped = new Promise((resolve) => { this.resolveStopped = resolve; });
    port.on("close", () => this.stop("abandoned"));
    this.progress();
  }

  get reason(): UploadStopReason | null { return this.stoppedReason; }

  progress(): void {
    if (this.stoppedReason || this.disposed || this.installing) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop("stalled"), ASSET_UPLOAD_IDLE_MS);
    this.timer.unref();
  }

  beginInstall(): void {
    this.installing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  onStop(listener: (reason: UploadStopReason) => void): () => void {
    if (this.stoppedReason) listener(this.stoppedReason);
    else if (!this.disposed) this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private stop(reason: UploadStopReason): void {
    if (this.stoppedReason || this.disposed) return;
    this.stoppedReason = reason;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.resolveStopped(reason);
    for (const listener of this.listeners) listener(reason);
    this.listeners.clear();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}

export type ReceivedUpload =
  | { kind: "staged"; staging: StagingFile; staged: StagedUpload }
  // The renderer could not read the file to its end and said so.
  | { kind: "source-unreadable" }
  // The port closed before the file ended: the window went away, or the renderer
  // broke the protocol. Nobody is waiting for an answer.
  | { kind: "abandoned" }
  | { kind: "stalled" }
  | { kind: "write-failed"; problem: WorkspaceWriteProblem; error: unknown };

function sliceOf(message: unknown): Uint8Array | null {
  if (message === null || typeof message !== "object") return null;
  const { type, data } = message as { type?: unknown; data?: unknown };
  if (type !== "slice" || !(data instanceof ArrayBuffer) || data.byteLength === 0 || data.byteLength > ASSET_UPLOAD_SLICE_BYTES) return null;
  return new Uint8Array(data);
}

function typeOf(message: unknown): unknown {
  return message !== null && typeof message === "object" ? (message as { type?: unknown }).type : undefined;
}

/**
 * Receives one upload's bytes from `port` into a new staged file under
 * `stagingDir`. Settles once, when the file has ended and is closed (the caller
 * then owns the staged file and must discard it after installing), or when the
 * upload cannot finish, with the staged file already removed.
 */
export async function receiveUpload(port: UploadPort, stagingDir: string, lifetime?: UploadLifetime): Promise<ReceivedUpload> {
  const ownsLifetime = lifetime === undefined;
  const observing = lifetime ?? new UploadLifetime(port);
  let unsubscribe = () => {};
  try {
    if (observing.reason) return { kind: observing.reason };
    let staging: StagingFile;
    try {
      staging = await StagingFile.create(stagingDir);
    } catch (error) {
      if (observing.reason) return { kind: observing.reason };
      return { kind: "write-failed", problem: workspaceWriteProblem(error) ?? "failed", error };
    }
    if (observing.reason) {
      await staging.discard();
      return { kind: observing.reason };
    }

    return await new Promise<ReceivedUpload>((resolve) => {
      let settled = false;
      let ending = false;
      let credits = ASSET_UPLOAD_SLICES_IN_FLIGHT;
      // Admission consumes credit synchronously, so this serial chain can hold
      // only the bounded number of slices the renderer was permitted to send.
      let writes = Promise.resolve();
      const stop = (outcome: Exclude<ReceivedUpload, { kind: "staged" }>) => {
        if (settled) return;
        settled = true;
        // The stage remains owned until every already-started I/O settles.
        void writes.then(() => staging.discard()).then(() => resolve(outcome));
      };
      const failWrite = (error: unknown) => stop({ kind: "write-failed", problem: workspaceWriteProblem(error) ?? "failed", error });
      const next = () => {
        try { port.postMessage({ type: "next" }); }
        catch { stop({ kind: "abandoned" }); }
      };
      unsubscribe = observing.onStop((reason) => stop({ kind: reason }));
      port.on("message", ({ data }) => {
        if (settled) return;
        if (ending) { stop({ kind: "abandoned" }); return; }
        const slice = sliceOf(data);
        if (slice) {
          if (credits <= 0) { stop({ kind: "abandoned" }); return; }
          credits -= 1;
          observing.progress();
          writes = writes.then(async () => {
            if (settled) return;
            await staging.write(slice);
            observing.progress();
            if (!settled && !ending) { credits += 1; next(); }
          }).catch(failWrite);
          return;
        }
        switch (typeOf(data)) {
          case "end":
            ending = true;
            observing.progress();
            writes = writes.then(async () => {
              if (settled) return;
              const staged = await staging.finish();
              observing.progress();
              if (settled) return;
              settled = true;
              resolve({ kind: "staged", staging, staged });
            }).catch(failWrite);
            return;
          case "abort":
            stop({ kind: "source-unreadable" });
            return;
          default:
            stop({ kind: "abandoned" });
        }
      });
      try {
        port.start();
        for (let credit = 0; credit < ASSET_UPLOAD_SLICES_IN_FLIGHT && !settled; credit += 1) next();
      } catch { stop({ kind: "abandoned" }); }
    });
  } finally {
    unsubscribe();
    if (ownsLifetime) observing.dispose();
  }
}
