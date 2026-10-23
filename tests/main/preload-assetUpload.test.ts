// The preload's half of an upload: it streams the picked file over its own port,
// reading each slice only when main asks for it, and settles with main's answer.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ASSET_UPLOAD_SLICE_BYTES, ASSET_UPLOAD_IDLE_MS, CHANNELS, type AssetUploadFromMain, type AssetUploadToMain, type BigMouthApi } from "@shared/ipc";
import { setImmediate as nextTurn } from "node:timers/promises";

const electron = vi.hoisted(() => {
  let api!: BigMouthApi;
  return {
    contextBridge: { exposeInMainWorld: (_name: string, exposed: BigMouthApi) => { api = exposed; } },
    ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn(), postMessage: vi.fn() },
    webUtils: { getPathForFile: vi.fn(() => "") },
    api: () => api,
  };
});
vi.mock("electron", () => electron);
await import("../../src/preload/index.js");

const ports: MessagePort[] = [];
afterEach(() => {
  for (const port of ports.splice(0)) port.close();
  vi.useRealTimers();
  electron.ipcRenderer.postMessage.mockReset();
  electron.webUtils.getPathForFile.mockReset().mockReturnValue("");
});

/** Main's end of the upload the preload just started, and what it receives on it. */
function mainSide(call = 0) {
  const [channel, start, [port]] = electron.ipcRenderer.postMessage.mock.calls[call] as [string, unknown, [MessagePort]];
  ports.push(port);
  const received: AssetUploadToMain[] = [];
  let arrived: () => void = () => {};
  port.onmessage = (event: MessageEvent<AssetUploadToMain>) => { received.push(event.data); arrived(); };
  const reply = (message: AssetUploadFromMain) => port.postMessage(message);
  /** Waits until `count` messages have arrived. */
  const until = async (count: number) => {
    while (received.length < count) await new Promise<void>((resolve) => { arrived = resolve; });
  };
  return { channel, start, received, reply, until, port };
}

describe("preload asset upload", () => {
  it("sends one slice per request, in order, then the end, and settles with main's result", async () => {
    electron.webUtils.getPathForFile.mockReturnValue("/Users/me/clip.bin");
    const bytes = Buffer.alloc(ASSET_UPLOAD_SLICE_BYTES + 10, "0123456789abcdef");
    const file = new File([bytes], "clip.bin");
    const slice = vi.spyOn(file, "slice");
    const upload = electron.api().uploadAsset("w1", "p1", file);
    const main = mainSide();
    expect(main.channel).toBe(CHANNELS.uploadAsset);
    expect(main.start).toEqual({ wsId: "w1", postId: "p1", name: "clip.bin", sourcePath: "/Users/me/clip.bin" });

    // Nothing is read until main asks.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(slice).not.toHaveBeenCalled();

    main.reply({ type: "next" });
    await main.until(1);
    expect(slice).toHaveBeenCalledTimes(1);
    main.reply({ type: "next" });
    main.reply({ type: "next" });
    await main.until(3);
    const [first, second, end] = main.received;
    expect(first).toMatchObject({ type: "slice" });
    expect(second).toMatchObject({ type: "slice" });
    expect(end).toEqual({ type: "end" });
    const sent = Buffer.concat([
      Buffer.from((first as { data: ArrayBuffer }).data),
      Buffer.from((second as { data: ArrayBuffer }).data),
    ]);
    expect(sent.equals(bytes)).toBe(true);
    expect((first as { data: ArrayBuffer }).data.byteLength).toBe(ASSET_UPLOAD_SLICE_BYTES);

    const result = { ok: true as const, asset: { filename: "clip.bin", size: bytes.length } };
    main.reply({ type: "result", result });
    await expect(upload).resolves.toEqual(result);
  });

  it("sends no source path for a file that has none on disk", async () => {
    const upload = electron.api().uploadAsset("w1", "p1", new File(["x"], "pasted.png"));
    const main = mainSide();
    expect(main.start).toEqual({ wsId: "w1", postId: "p1", name: "pasted.png" });
    main.reply({ type: "result", result: { ok: true, asset: { filename: "pasted.png", size: 1 } } });
    await upload;
  });

  it.each(["admission", "next slice"])("aborts an upload stalled waiting for %s credit", async (waitingFor) => {
    vi.useFakeTimers();
    const upload = electron.api().uploadAsset("w", "p", new File(["x"], "a.bin"));
    const main = mainSide();
    if (waitingFor === "next slice") {
      main.reply({ type: "next" });
      await main.until(1);
    }
    await vi.advanceTimersByTimeAsync(ASSET_UPLOAD_IDLE_MS);
    await expect(upload).resolves.toEqual({ ok: false, failure: { code: "stalled" } });
    await main.until(waitingFor === "admission" ? 1 : 2);
    expect(main.received).toEqual(waitingFor === "admission"
      ? [{ type: "abort" }]
      : [{ type: "slice", data: expect.any(ArrayBuffer) }, { type: "abort" }]);
    expect(vi.getTimerCount()).toBe(0);
    const next = electron.api().uploadAsset("w", "p", new File([], "next.bin"));
    expect(electron.ipcRenderer.postMessage).toHaveBeenCalledTimes(2);
    mainSide(1).reply({ type: "result", result: { ok: true, asset: { filename: "next.bin", size: 0 } } });
    await expect(next).resolves.toMatchObject({ ok: true });
  });

  it.each(["completes", "rejects"])("abandons a stalled source read that later %s, sending no late bytes or install acknowledgement", async (outcome) => {
    vi.useFakeTimers();
    const file = new File(["x"], "a.bin");
    let complete!: (data: ArrayBuffer) => void;
    let fail!: (error: unknown) => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const bytes = new Promise<ArrayBuffer>((resolve, reject) => { complete = resolve; fail = reject; });
    vi.spyOn(file, "slice").mockReturnValue({ arrayBuffer: () => { started(); return bytes; } } as Blob);
    const upload = electron.api().uploadAsset("w", "p", file);
    const main = mainSide();
    main.reply({ type: "next" });
    await reading;
    await vi.advanceTimersByTimeAsync(ASSET_UPLOAD_IDLE_MS);
    await expect(upload).resolves.toEqual({ ok: false, failure: { code: "stalled" } });
    await main.until(1);
    await expect(electron.api().uploadAsset("w", "p", new File([], "blocked.bin")))
      .resolves.toEqual({ ok: false, failure: { code: "busy" } });
    expect(electron.ipcRenderer.postMessage).toHaveBeenCalledOnce();
    const otherWorkspace = electron.api().uploadAsset("other-workspace", "p", new File([], "other.bin"));
    expect(electron.ipcRenderer.postMessage).toHaveBeenCalledTimes(2);
    mainSide(1).reply({ type: "result", result: { ok: true, asset: { filename: "other.bin", size: 0 } } });
    await expect(otherWorkspace).resolves.toMatchObject({ ok: true });
    if (outcome === "completes") complete(new ArrayBuffer(1));
    else fail(new Error("source disappeared after timeout"));
    main.reply({ type: "installing" });
    await nextTurn();
    await nextTurn();
    expect(main.received).toEqual([{ type: "abort" }]);
    expect(vi.getTimerCount()).toBe(0);
    const next = electron.api().uploadAsset("w", "p", new File([], "next.bin"));
    expect(electron.ipcRenderer.postMessage).toHaveBeenCalledTimes(3);
    const successor = mainSide(2);
    // Settling the old read must not clear this new upload's claim.
    await nextTurn();
    await expect(electron.api().uploadAsset("w", "p", new File([], "overlapping.bin")))
      .resolves.toEqual({ ok: false, failure: { code: "busy" } });
    successor.reply({ type: "result", result: { ok: true, asset: { filename: "next.bin", size: 0 } } });
    await expect(next).resolves.toMatchObject({ ok: true });
  });

  it("restarts inactivity on credit and on completed source read and send", async () => {
    vi.useFakeTimers();
    const file = new File(["x"], "a.bin");
    let complete!: (data: ArrayBuffer) => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(file, "slice").mockReturnValue({ arrayBuffer: () => {
      started();
      return new Promise<ArrayBuffer>((resolve) => { complete = resolve; });
    } } as Blob);
    const upload = electron.api().uploadAsset("w", "p", file);
    const done = vi.fn();
    void upload.then(done);
    const main = mainSide();
    await vi.advanceTimersByTimeAsync(ASSET_UPLOAD_IDLE_MS - 1);
    main.reply({ type: "next" });
    await reading;
    await vi.advanceTimersByTimeAsync(ASSET_UPLOAD_IDLE_MS - 1);
    expect(done).not.toHaveBeenCalled();
    complete(new ArrayBuffer(1));
    await main.until(1);
    await vi.advanceTimersByTimeAsync(ASSET_UPLOAD_IDLE_MS - 1);
    expect(done).not.toHaveBeenCalled();
    expect(main.received).toEqual([{ type: "slice", data: new ArrayBuffer(1) }]);
    main.reply({ type: "result", result: { ok: true, asset: { filename: "a.bin", size: 1 } } });
    await upload;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("acknowledges installation then waits for its actual result without an inactivity deadline", async () => {
    vi.useFakeTimers();
    const upload = electron.api().uploadAsset("w", "p", new File([], "a.bin"));
    const done = vi.fn();
    void upload.then(done);
    const main = mainSide();
    main.reply({ type: "next" });
    await main.until(1);
    main.reply({ type: "installing" });
    await main.until(2);
    expect(main.received).toEqual([{ type: "end" }, { type: "install" }]);
    await vi.advanceTimersByTimeAsync(ASSET_UPLOAD_IDLE_MS * 3);
    expect(done).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const result = { ok: true as const, asset: { filename: "a.bin", size: 0 } };
    main.reply({ type: "result", result });
    await expect(upload).resolves.toEqual(result);
  });

  it("tells main to stop and says the file could not be read when a slice cannot be read", async () => {
    const file = new File(["moved away"], "moved.png");
    vi.spyOn(file, "slice").mockReturnValue({ arrayBuffer: () => Promise.reject(new DOMException("gone", "NotReadableError")) } as unknown as Blob);
    const upload = electron.api().uploadAsset("w1", "p1", file);
    const main = mainSide();
    main.reply({ type: "next" });
    await expect(upload).resolves.toEqual({ ok: false, failure: { code: "source-unreadable" } });
    await main.until(1);
    expect(main.received).toEqual([{ type: "abort" }]);
  });

  it("rejects with main's own words when main reports a failure", async () => {
    const upload = electron.api().uploadAsset("w1", "p1", new File(["x"], "a.png"));
    mainSide().reply({ type: "failed", message: "The file could not be added." });
    await expect(upload).rejects.toThrow("The file could not be added.");
  });
});
