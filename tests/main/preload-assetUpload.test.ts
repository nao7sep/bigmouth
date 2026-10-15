// The preload's half of an upload: it streams the picked file over its own port,
// reading each slice only when main asks for it, and settles with main's answer.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ASSET_UPLOAD_SLICE_BYTES, CHANNELS, type AssetUploadFromMain, type AssetUploadToMain, type BigMouthApi } from "@shared/ipc";

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

afterEach(() => {
  electron.ipcRenderer.postMessage.mockReset();
  electron.webUtils.getPathForFile.mockReset().mockReturnValue("");
});

/** Main's end of the upload the preload just started, and what it receives on it. */
function mainSide() {
  const [channel, start, [port]] = electron.ipcRenderer.postMessage.mock.calls[0] as [string, unknown, [MessagePort]];
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
    void electron.api().uploadAsset("w1", "p1", new File(["x"], "pasted.png"));
    expect(mainSide().start).toEqual({ wsId: "w1", postId: "p1", name: "pasted.png" });
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
