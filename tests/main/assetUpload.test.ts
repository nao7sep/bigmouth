// The main-process upload receiver: bytes arrive in slices on a port and go to a
// staged file, hashed as they land, with only a few slices held at any time.
// Every way an upload can stop leaves no staged file behind.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import v8 from "node:v8";
import vm from "node:vm";
import { EventEmitter, once } from "node:events";
import { MessageChannel } from "node:worker_threads";

import { receiveUpload, StagingFile, UploadLifetime, type UploadPort } from "@main/assetUpload.js";
import { ASSET_UPLOAD_SLICE_BYTES, ASSET_UPLOAD_SLICES_IN_FLIGHT, ASSET_UPLOAD_IDLE_MS, type AssetUploadFromMain } from "@shared/ipc";
import { mainEnd, playRenderer, slicesOf } from "./uploadStream.js";

let root: string;
let staging: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-upload-"));
  staging = path.join(root, ".staging");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

const staged = () => (fs.existsSync(staging) ? fs.readdirSync(staging) : []);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

class ControlledPort extends EventEmitter implements UploadPort {
  readonly sent: AssetUploadFromMain[] = [];
  postMessage(message: AssetUploadFromMain): void {
    this.sent.push(message);
    this.emit("credit");
  }
  start(): void {}
  slice(size = 1): void { this.emit("message", { data: { type: "slice", data: new ArrayBuffer(size) } }); }
  end(): void { this.emit("message", { data: { type: "end" } }); }
  close(): void { this.emit("close"); }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("UploadLifetime", () => {
  it("bounds inactivity from construction and resets on progress without refreshing after stop", async () => {
    vi.useFakeTimers();
    const port = new ControlledPort();
    const lifetime = new UploadLifetime(port);
    const stopped = vi.fn();
    lifetime.onStop(stopped);
    await vi.advanceTimersByTimeAsync(ASSET_UPLOAD_IDLE_MS - 1);
    expect(lifetime.reason).toBeNull();
    lifetime.progress();
    await vi.advanceTimersByTimeAsync(ASSET_UPLOAD_IDLE_MS - 1);
    expect(lifetime.reason).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await lifetime.stopped).toBe("stalled");
    port.close();
    lifetime.progress();
    expect(stopped).toHaveBeenCalledExactlyOnceWith("stalled");
    expect(vi.getTimerCount()).toBe(0);
    lifetime.dispose();
  });

  it("disables inactivity permanently for installation but still observes abandonment", async () => {
    vi.useFakeTimers();
    const port = new ControlledPort();
    const lifetime = new UploadLifetime(port);
    const removed = vi.fn();
    const unsubscribe = lifetime.onStop(removed);
    unsubscribe();
    lifetime.beginInstall();
    lifetime.progress();
    await vi.advanceTimersByTimeAsync(ASSET_UPLOAD_IDLE_MS * 2);
    expect(lifetime.reason).toBeNull();
    port.close();
    expect(await lifetime.stopped).toBe("abandoned");
    expect(removed).not.toHaveBeenCalled();
    const late = vi.fn();
    lifetime.onStop(late);
    expect(late).toHaveBeenCalledExactlyOnceWith("abandoned");
    lifetime.dispose();
  });

  it("clears the inactivity timer when disposed", async () => {
    vi.useFakeTimers();
    const lifetime = new UploadLifetime(new ControlledPort());
    lifetime.dispose();
    await vi.advanceTimersByTimeAsync(ASSET_UPLOAD_IDLE_MS * 2);
    expect(lifetime.reason).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("receiveUpload", () => {
  it("observes a close before staging starts", async () => {
    const port = new ControlledPort();
    const lifetime = new UploadLifetime(port);
    port.close();
    const create = vi.spyOn(StagingFile, "create");
    expect(await receiveUpload(port, staging, lifetime)).toEqual({ kind: "abandoned" });
    expect(create).not.toHaveBeenCalled();
    expect(staged()).toEqual([]);
    lifetime.dispose();
  });

  it("cleans up a stage created after the port already closed", async () => {
    const port = new ControlledPort();
    const gate = deferred();
    const create = StagingFile.create;
    vi.spyOn(StagingFile, "create").mockImplementation(async (dir) => {
      await gate.promise;
      return create(dir);
    });
    const receiving = receiveUpload(port, staging);
    port.close();
    gate.resolve();
    expect(await receiving).toEqual({ kind: "abandoned" });
    expect(port.sent).toEqual([]);
    expect(staged()).toEqual([]);
  });

  it("reports a stalled write immediately through its lifetime but keeps the stage until the write settles", async () => {
    vi.useFakeTimers();
    const port = new ControlledPort();
    const lifetime = new UploadLifetime(port);
    const gate = deferred();
    const started = deferred();
    const original = StagingFile.prototype.write;
    vi.spyOn(StagingFile.prototype, "write").mockImplementation(async function (this: StagingFile, bytes) {
      started.resolve();
      await gate.promise;
      await original.call(this, bytes);
    });
    const discard = vi.spyOn(StagingFile.prototype, "discard");
    const ready = once(port, "credit");
    const receiving = receiveUpload(port, staging, lifetime);
    let settled = false;
    void receiving.then(() => { settled = true; });
    await ready;
    port.slice();
    await started.promise;
    await vi.advanceTimersByTimeAsync(ASSET_UPLOAD_IDLE_MS);
    expect(await lifetime.stopped).toBe("stalled");
    expect(settled).toBe(false);
    expect(staged()).toHaveLength(1);
    expect(discard).not.toHaveBeenCalled();
    gate.resolve();
    expect(await receiving).toEqual({ kind: "stalled" });
    expect(staged()).toEqual([]);
    lifetime.dispose();
  });

  it("refreshes inactivity when a real write completes and lets a progressing upload end", async () => {
    vi.useFakeTimers();
    const port = new ControlledPort();
    const lifetime = new UploadLifetime(port);
    const gate = deferred();
    const started = deferred();
    const original = StagingFile.prototype.write;
    vi.spyOn(StagingFile.prototype, "write").mockImplementation(async function (this: StagingFile, bytes) {
      started.resolve();
      await gate.promise;
      await original.call(this, bytes);
    });
    const ready = once(port, "credit");
    const receiving = receiveUpload(port, staging, lifetime);
    await ready;
    port.slice();
    await started.promise;
    await vi.advanceTimersByTimeAsync(ASSET_UPLOAD_IDLE_MS / 2);
    const written = once(port, "credit");
    gate.resolve();
    await written;
    await vi.advanceTimersByTimeAsync(ASSET_UPLOAD_IDLE_MS / 2 + 1);
    expect(lifetime.reason).toBeNull();
    port.end();
    const result = await receiving;
    expect(result.kind).toBe("staged");
    if (result.kind === "staged") await result.staging.discard();
    lifetime.dispose();
  });

  it("refuses credit overruns without building an unbounded write queue", async () => {
    const port = new ControlledPort();
    const gate = deferred();
    const started = deferred();
    const original = StagingFile.prototype.write;
    const write = vi.spyOn(StagingFile.prototype, "write").mockImplementation(async function (this: StagingFile, bytes) {
      started.resolve();
      await gate.promise;
      await original.call(this, bytes);
    });
    const ready = once(port, "credit");
    const receiving = receiveUpload(port, staging);
    await ready;
    port.slice();
    await started.promise;
    for (let index = 1; index <= ASSET_UPLOAD_SLICES_IN_FLIGHT; index += 1) port.slice();
    expect(port.sent).toHaveLength(ASSET_UPLOAD_SLICES_IN_FLIGHT);
    gate.resolve();
    expect(await receiving).toEqual({ kind: "abandoned" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(staged()).toEqual([]);
  });

  it("refuses an empty slice separately from the valid empty-file end message", async () => {
    const port = new ControlledPort();
    const ready = once(port, "credit");
    const receiving = receiveUpload(port, staging);
    await ready;
    port.slice(0);
    expect(await receiving).toEqual({ kind: "abandoned" });
    expect(staged()).toEqual([]);
  });

  it("fails and discards the stage instead of spinning when the filesystem writes zero bytes", async () => {
    const open = fsp.open;
    const write = vi.fn(async () => ({ bytesWritten: 0, buffer: new Uint8Array(0) }));
    vi.spyOn(fsp, "open").mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await open(...args);
      (handle as unknown as { write: typeof write }).write = write;
      return handle;
    });
    const port = new ControlledPort();
    const ready = once(port, "credit");
    const receiving = receiveUpload(port, staging);
    await ready;
    port.slice();
    expect(await receiving).toMatchObject({ kind: "write-failed", problem: "failed" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(staged()).toEqual([]);
  });

  it("stages the exact bytes with their hash and length", async () => {
    // Two whole slices and a part, with every byte value.
    const bytes = Buffer.alloc(ASSET_UPLOAD_SLICE_BYTES * 2 + 1000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 7) & 0xff;
    const { port1, port2 } = new MessageChannel();
    void playRenderer(port1, slicesOf(bytes, ASSET_UPLOAD_SLICE_BYTES));
    const received = await receiveUpload(mainEnd(port2), staging);
    port2.close();

    expect(received.kind).toBe("staged");
    if (received.kind !== "staged") return;
    expect(received.staged).toEqual({ name: path.basename(received.staging.path), sha256: sha(bytes), size: bytes.length });
    expect(fs.readFileSync(received.staging.path).equals(bytes)).toBe(true);
    // Private while it is a stage.
    if (process.platform !== "win32") expect(fs.statSync(received.staging.path).mode & 0o777).toBe(0o600);
    await received.staging.discard();
    expect(staged()).toEqual([]);
  });

  it("stages an empty file", async () => {
    const { port1, port2 } = new MessageChannel();
    void playRenderer(port1, () => null);
    const received = await receiveUpload(mainEnd(port2), staging);
    port2.close();
    expect(received).toMatchObject({ kind: "staged", staged: { sha256: sha(new Uint8Array(0)), size: 0 } });
  });

  // Peak memory is the point of streaming: an upload of any size holds a few
  // slices. The file is generated slice by slice as main asks for it, so the
  // test itself never holds it either. Each sample follows a full collection,
  // so it measures what is held, not slices already let go that V8 has not
  // reclaimed yet.
  it("holds only a few slices in memory however large the file", async () => {
    v8.setFlagsFromString("--expose-gc");
    const collect = vm.runInNewContext("gc") as () => void;
    const total = 256 * 1024 * 1024;
    const count = total / ASSET_UPLOAD_SLICE_BYTES;
    const expected = createHash("sha256");
    collect();
    const baseline = process.memoryUsage();
    let peakBuffers = 0;
    let peakRss = 0;
    const sample = () => {
      collect();
      const now = process.memoryUsage();
      peakBuffers = Math.max(peakBuffers, now.arrayBuffers - baseline.arrayBuffers);
      peakRss = Math.max(peakRss, now.rss - baseline.rss);
    };
    const { port1, port2 } = new MessageChannel();
    void playRenderer(port1, (index) => {
      sample();
      if (index === count) return null;
      const slice = new Uint8Array(ASSET_UPLOAD_SLICE_BYTES).fill(index & 0xff);
      expected.update(slice);
      return slice;
    });
    const received = await receiveUpload(mainEnd(port2), staging);
    port2.close();
    sample();

    expect(received.kind).toBe("staged");
    if (received.kind !== "staged") return;
    expect(received.staged.size).toBe(total);
    expect(received.staged.sha256).toBe(expected.digest("hex"));
    expect(fs.statSync(received.staging.path).size).toBe(total);
    // The slices in flight and the one being made, against the 256 MB that
    // passed through; measured at about 8 MB.
    expect(peakBuffers).toBeLessThan(24 * 1024 * 1024);
    expect(peakRss).toBeLessThan(64 * 1024 * 1024);
    await received.staging.discard();
  }, 60_000);

  it("removes the stage when the renderer cannot read the file to its end", async () => {
    const { port1, port2 } = new MessageChannel();
    const renderer = playRenderer(port1, (index) => (index === 0 ? new Uint8Array(1024).fill(1) : "abort"));
    expect(await receiveUpload(mainEnd(port2), staging)).toEqual({ kind: "source-unreadable" });
    port2.close();
    await renderer;
    expect(staged()).toEqual([]);
  });

  it("removes the stage when the renderer goes away mid-file", async () => {
    const { port1, port2 } = new MessageChannel();
    void playRenderer(port1, (index) => (index < 2 ? new Uint8Array(1024).fill(index) : "close"));
    expect(await receiveUpload(mainEnd(port2), staging)).toEqual({ kind: "abandoned" });
    expect(staged()).toEqual([]);
  });

  it("removes the stage and stops on a slice larger than the protocol allows", async () => {
    const { port1, port2 } = new MessageChannel();
    void playRenderer(port1, () => new Uint8Array(ASSET_UPLOAD_SLICE_BYTES + 1));
    expect(await receiveUpload(mainEnd(port2), staging)).toEqual({ kind: "abandoned" });
    port2.close();
    expect(staged()).toEqual([]);
  });

  it.each([
    ["ENOSPC", "full"],
    ["EACCES", "denied"],
    ["EIO", "failed"],
  ] as const)("removes the stage when a write fails with %s, and says the workspace folder could not take it", async (code, problem) => {
    const open = fsp.open;
    vi.spyOn(fsp, "open").mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await open(...args);
      let writes = 0;
      const write = handle.write.bind(handle) as (...a: unknown[]) => Promise<unknown>;
      // The first slice lands; the second meets the failure.
      (handle as unknown as { write: (...a: unknown[]) => Promise<unknown> }).write = (...a) => {
        if (++writes > 1) return Promise.reject(Object.assign(new Error(`${code}: write`), { code }));
        return write(...a);
      };
      return handle as FileHandle;
    });
    const { port1, port2 } = new MessageChannel();
    void playRenderer(port1, (index) => (index < 4 ? new Uint8Array(1024).fill(index) : null));
    const received = await receiveUpload(mainEnd(port2), staging);
    port2.close();
    expect(received).toMatchObject({ kind: "write-failed", problem });
    expect(staged()).toEqual([]);
  });

  it("says the workspace folder could not take the file when the stage cannot be created", async () => {
    vi.spyOn(fsp, "mkdir").mockRejectedValue(Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" }));
    const { port2 } = new MessageChannel();
    expect(await receiveUpload(mainEnd(port2), staging)).toMatchObject({ kind: "write-failed", problem: "denied" });
    port2.close();
  });
});
