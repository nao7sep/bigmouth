// The registry main consults before quitting or closing a window: which windows
// show a metadata value the store refused (and so never buffered).

import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { on: () => {} } }));

import {
  anyRefusedMetadata,
  forgetRefusedMetadata,
  holdsRefusedMetadata,
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
  it("holds a window while any of its posts shows a refused value", () => {
    const a = owner(101);
    setMetadataRefusal(a.value, "p1", true);
    setMetadataRefusal(a.value, "p2", true);
    expect(holdsRefusedMetadata(101)).toBe(true);
    expect(anyRefusedMetadata()).toBe(true);

    setMetadataRefusal(a.value, "p1", false);
    expect(holdsRefusedMetadata(101)).toBe(true);
    setMetadataRefusal(a.value, "p2", false);
    expect(holdsRefusedMetadata(101)).toBe(false);
    expect(anyRefusedMetadata()).toBe(false);
  });

  it("keeps windows apart, and lets go of one that closed, crashed or was closed anyway", () => {
    const a = owner(201);
    const b = owner(202);
    const c = owner(203);
    setMetadataRefusal(a.value, "p1", true);
    setMetadataRefusal(b.value, "p1", true);
    setMetadataRefusal(c.value, "p1", true);

    a.emit("destroyed");
    expect(holdsRefusedMetadata(201)).toBe(false);
    expect(holdsRefusedMetadata(202)).toBe(true);

    b.emit("render-process-gone");
    expect(holdsRefusedMetadata(202)).toBe(false);

    forgetRefusedMetadata(203);
    expect(holdsRefusedMetadata(203)).toBe(false);
    expect(anyRefusedMetadata()).toBe(false);
  });
});
