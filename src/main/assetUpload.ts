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

export type ReceivedUpload =
  | { kind: "staged"; staging: StagingFile; staged: StagedUpload }
  // The renderer could not read the file to its end and said so.
  | { kind: "source-unreadable" }
  // The port closed before the file ended: the window went away, or the renderer
  // broke the protocol. Nobody is waiting for an answer.
  | { kind: "abandoned" }
  | { kind: "write-failed"; problem: WorkspaceWriteProblem; error: unknown };

function sliceOf(message: unknown): Uint8Array | null {
  if (message === null || typeof message !== "object") return null;
  const { type, data } = message as { type?: unknown; data?: unknown };
  if (type !== "slice" || !(data instanceof ArrayBuffer) || data.byteLength > ASSET_UPLOAD_SLICE_BYTES) return null;
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
export async function receiveUpload(port: UploadPort, stagingDir: string): Promise<ReceivedUpload> {
  let staging: StagingFile;
  try {
    staging = await StagingFile.create(stagingDir);
  } catch (error) {
    return { kind: "write-failed", problem: workspaceWriteProblem(error) ?? "failed", error };
  }

  return await new Promise<ReceivedUpload>((resolve) => {
    let settled = false;
    // Slices are written strictly in order; each later step waits for the one before.
    let writes = Promise.resolve();
    const stop = (outcome: Exclude<ReceivedUpload, { kind: "staged" }>) => {
      if (settled) return;
      settled = true;
      // The stage is removed only after its last write has stopped.
      void writes.then(() => staging.discard()).then(() => resolve(outcome));
    };
    const failWrite = (error: unknown) => stop({ kind: "write-failed", problem: workspaceWriteProblem(error) ?? "failed", error });

    port.on("message", ({ data }) => {
      if (settled) return;
      const slice = sliceOf(data);
      if (slice) {
        writes = writes.then(async () => {
          if (settled) return;
          await staging.write(slice);
          if (!settled) port.postMessage({ type: "next" });
        }).catch(failWrite);
        return;
      }
      switch (typeOf(data)) {
        case "end":
          writes = writes.then(async () => {
            if (settled) return;
            const staged = await staging.finish();
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
    port.on("close", () => stop({ kind: "abandoned" }));
    port.start();
    for (let credit = 0; credit < ASSET_UPLOAD_SLICES_IN_FLIGHT; credit += 1) port.postMessage({ type: "next" });
  });
}
