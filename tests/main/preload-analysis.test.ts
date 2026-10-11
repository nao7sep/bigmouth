import { describe, expect, it, vi } from "vitest";
import { CHANNELS, type BigMouthApi } from "@shared/ipc";

const electron = vi.hoisted(() => {
  let api!: BigMouthApi;
  return {
    contextBridge: { exposeInMainWorld: (_name: string, exposed: BigMouthApi) => { api = exposed; } },
    ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
    api: () => api,
  };
});
vi.mock("electron", () => electron);
await import("../../src/preload/index.js");

describe("preload analysis cancellation", () => {
  it("sends Stop while the start invocation is still preparing and settles once", async () => {
    let start!: () => void;
    electron.ipcRenderer.invoke.mockReturnValueOnce(new Promise<void>((resolve) => { start = resolve; }));
    const handle = electron.api().runAnalysisStream({ wsId: "w", postId: "p", promptName: "Review", content: "draft" }, vi.fn());
    const result = handle.done.catch((error: unknown) => error);
    const requestId = electron.ipcRenderer.invoke.mock.calls[0][1];
    handle.abort();
    handle.abort();
    expect(electron.ipcRenderer.send).toHaveBeenCalledExactlyOnceWith(CHANNELS.aiRequestAbort, requestId);
    expect(await result).toEqual(new Error("Analysis aborted"));
    start();
    await Promise.resolve();
    expect(electron.ipcRenderer.send).toHaveBeenCalledTimes(1);
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledTimes(1);
  });
});
