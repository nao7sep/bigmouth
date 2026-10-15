// The registry main consults before quitting: which windows
// show a metadata value the store refused (and so never buffered).

import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { on: () => {} } }));

import {
  anyRefusedMetadata,
  setMetadataRefusal,
  type RefusalOwner,
} from "@main/ipc/refusedMetadata.js";

function owner(id: number) {
  const listeners = new Map<string, () => void>();
  const value: RefusalOwner = {
    id,
    once: (event, listener) => listeners.set(event, listener),
    on: (event, listener) => listeners.set(event, listener),
  };
  return { value, emit: (event: string) => listeners.get(event)?.() };
}

describe("refused metadata registry", () => {
  it("counts while any post in any window shows a refused value", () => {
    const a = owner(101);
    setMetadataRefusal(a.value, "p1", true);
    setMetadataRefusal(a.value, "p2", true);
    expect(anyRefusedMetadata()).toBe(true);

    setMetadataRefusal(a.value, "p1", false);
    expect(anyRefusedMetadata()).toBe(true);
    setMetadataRefusal(a.value, "p2", false);
    expect(anyRefusedMetadata()).toBe(false);
  });

  it("lets go of a window that closed or crashed", () => {
    const a = owner(201);
    const b = owner(202);
    setMetadataRefusal(a.value, "p1", true);
    setMetadataRefusal(b.value, "p1", true);

    a.emit("destroyed");
    expect(anyRefusedMetadata()).toBe(true);
    b.emit("render-process-gone");
    expect(anyRefusedMetadata()).toBe(false);
  });
});
