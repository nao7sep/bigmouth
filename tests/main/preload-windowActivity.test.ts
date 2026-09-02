import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BigMouthApi } from "@shared/ipc";
import { CHANNELS } from "@shared/ipc";

const electron = vi.hoisted(() => {
  let exposed: BigMouthApi | undefined;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    contextBridge: {
      exposeInMainWorld: vi.fn((_name: string, api: BigMouthApi) => { exposed = api; }),
    },
    ipcRenderer: {
      invoke: vi.fn(),
      send: vi.fn(),
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        listeners.set(channel, listener);
      }),
      removeListener: vi.fn(),
    },
    api: () => exposed,
    listeners,
  };
});

vi.mock("electron", () => ({
  contextBridge: electron.contextBridge,
  ipcRenderer: electron.ipcRenderer,
}));

await import("../../src/preload/index.js");

beforeEach(() => {
  electron.ipcRenderer.on.mockClear();
  electron.ipcRenderer.removeListener.mockClear();
});

describe("preload window activity bridge", () => {
  it("forwards only boolean native activity and removes the exact listener", () => {
    const listener = vi.fn();
    const cleanup = electron.api()?.onWindowActivityChanged(listener);
    const wrapped = electron.listeners.get(CHANNELS.windowActivityChanged);

    wrapped?.({}, false);
    wrapped?.({}, "not native state");
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(false);

    cleanup?.();
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      CHANNELS.windowActivityChanged,
      wrapped,
    );
  });
});
