// Both ends of an upload's port, for tests that drive the main-process receiver
// without Electron: Node's MessageChannel stands in for the renderer's, and
// `mainEnd` gives main's end the shape of Electron's MessagePortMain.

import type { MessagePort } from "node:worker_threads";
import type { UploadPort } from "@main/assetUpload.js";
import type { AssetUploadFromMain, AssetUploadToMain } from "@shared/ipc";

/** Main's end of an upload channel, shaped like Electron's MessagePortMain. */
export function mainEnd(port: MessagePort): UploadPort & { close(): void } {
  const end = {
    on(event: "message" | "close", listener: (...args: never[]) => void) {
      if (event === "message") port.on("message", (data: unknown) => (listener as (event: { data: unknown }) => void)({ data }));
      else port.on("close", listener as () => void);
      return end;
    },
    postMessage: (message: AssetUploadFromMain) => port.postMessage(message),
    start: () => port.start(),
    close: () => port.close(),
  };
  return end as UploadPort & { close(): void };
}

/**
 * What the renderer does when main asks for slice `index`: send these bytes,
 * end the file (null), report that the file could not be read ("abort"), or go
 * away ("close").
 */
export type SliceStep = Uint8Array | null | "abort" | "close";

/**
 * Plays the renderer's side of an upload on `port`: each `next` from main is
 * answered with the following step, and the returned promise settles with
 * main's final message, or null when the port closed without one.
 */
export function playRenderer(port: MessagePort, step: (index: number) => SliceStep): Promise<AssetUploadFromMain | null> {
  return new Promise((resolve) => {
    let index = 0;
    let done = false;
    // Like the preload, nothing is sent after the end of the file or a failed read.
    let ended = false;
    const finish = (reply: AssetUploadFromMain | null) => {
      if (done) return;
      done = true;
      port.close();
      resolve(reply);
    };
    const send = (message: AssetUploadToMain) => port.postMessage(message);
    port.on("message", (reply: AssetUploadFromMain) => {
      if (reply.type === "installing") {
        send({ type: "install" });
        return;
      }
      if (reply.type !== "next") {
        finish(reply);
        return;
      }
      if (done || ended) return;
      const next = step(index++);
      if (next === "close") finish(null);
      else if (next === "abort") { ended = true; send({ type: "abort" }); }
      else if (next === null) { ended = true; send({ type: "end" }); }
      else {
        // A tight ArrayBuffer of its own, sent as a copy, as the preload sends
        // slices; a Buffer's view may share a larger pool.
        const data = new ArrayBuffer(next.byteLength);
        new Uint8Array(data).set(next);
        send({ type: "slice", data });
      }
    });
    port.on("close", () => finish(null));
  });
}

/** Steps that send `bytes` in slices of `size`, then end the file. */
export function slicesOf(bytes: Uint8Array, size: number): (index: number) => SliceStep {
  return (index) => {
    const start = index * size;
    if (start >= bytes.byteLength) return null;
    return bytes.subarray(start, start + size);
  };
}
