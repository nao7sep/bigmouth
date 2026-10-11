import { expect, it, vi } from "vitest";
import { CHANNELS, type BigMouthApi } from "@shared/ipc";

const electron = vi.hoisted(() => ({
  api: undefined as BigMouthApi | undefined,
  listeners: new Map<string, (...args: unknown[]) => void>(),
  invoke: vi.fn().mockResolvedValue(true),
  removeListener: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: BigMouthApi) => { electron.api = api; } },
  ipcRenderer: {
    invoke: electron.invoke,
    on: (channel: string, callback: (...args: unknown[]) => void) => electron.listeners.set(channel, callback),
    removeListener: electron.removeListener,
    send: vi.fn(),
  },
}));
await import("../../src/preload/index.js");

it("carries pending storage settlement through the bridge and releases its subscription", async () => {
  const api = electron.api!;
  expect(await api.getStoragePending()).toBe(true);
  expect(electron.invoke).toHaveBeenCalledWith(CHANNELS.getStoragePending);
  const listener = vi.fn();
  const dispose = api.onStoragePendingChanged(listener);
  const callback = electron.listeners.get(CHANNELS.storagePendingChanged)!;
  callback({}, true);
  callback({}, "invalid");
  callback({}, false);
  expect(listener.mock.calls).toEqual([[true], [false]]);
  dispose();
  expect(electron.removeListener).toHaveBeenCalledWith(CHANNELS.storagePendingChanged, callback);
});
