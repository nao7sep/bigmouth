import { describe, it, expect } from "vitest";

import { isFieldDirty, dirtyFieldKeys, flushDirtyFields } from "@renderer/util/dirtyFields";

describe("isFieldDirty / dirtyFieldKeys", () => {
  it("treats undefined and empty string as equal", () => {
    expect(isFieldDirty(undefined, "")).toBe(false);
    expect(isFieldDirty("", undefined)).toBe(false);
    expect(isFieldDirty("a", "b")).toBe(true);
  });

  it("lists only the keys whose current value differs from the saved snapshot", () => {
    expect(dirtyFieldKeys({ a: "1", b: "2" }, { a: "1", b: "x" })).toEqual(["b"]);
    expect(dirtyFieldKeys({ a: "1" }, { a: "1" })).toEqual([]);
  });
});

describe("flushDirtyFields", () => {
  it("persists each dirty field once when nothing changes mid-flight", async () => {
    const current: Record<string, string> = { a: "1", b: "2" };
    const saved: Record<string, string> = {};
    const persisted: string[] = [];
    const persist = async (key: string): Promise<boolean> => {
      persisted.push(key);
      saved[key] = current[key];
      return true;
    };

    const ok = await flushDirtyFields(() => dirtyFieldKeys(current, saved), persist);
    expect(ok).toBe(true);
    expect(persisted.sort()).toEqual(["a", "b"]);
    expect(saved).toEqual(current);
  });

  it("re-persists a field edited while its save was in flight (no lost edit)", async () => {
    const current: Record<string, string> = { title: "v1" };
    const saved: Record<string, string> = {};
    const persists: Array<{ key: string; value: string }> = [];
    let firstPass = true;

    const persist = async (key: string): Promise<boolean> => {
      const value = current[key]; // the value at the moment the save started
      // Simulate the user editing the field WHILE this save is in flight.
      if (firstPass && key === "title") {
        firstPass = false;
        current.title = "v2";
      }
      saved[key] = value; // the snapshot records what was written, not the newer edit
      persists.push({ key, value });
      return true;
    };

    const ok = await flushDirtyFields(() => dirtyFieldKeys(current, saved), persist);
    expect(ok).toBe(true);
    // title is persisted twice: first "v1", then the in-flight "v2" — converged,
    // and the mid-save edit was never dropped.
    expect(persists).toEqual([
      { key: "title", value: "v1" },
      { key: "title", value: "v2" },
    ]);
    expect(saved.title).toBe("v2");
  });

  it("is a no-op that succeeds when nothing is dirty (e.g. a flush during load)", async () => {
    let persistCalls = 0;
    const ok = await flushDirtyFields(
      () => [],
      async () => {
        persistCalls += 1;
        return true;
      },
    );
    expect(ok).toBe(true);
    expect(persistCalls).toBe(0);
  });

  it("stops the drain and returns false on a failed persist", async () => {
    const current: Record<string, string> = { a: "1", b: "2" };
    const saved: Record<string, string> = {};
    const persist = async (key: string): Promise<boolean> => {
      if (key === "a") return false;
      saved[key] = current[key];
      return true;
    };

    const ok = await flushDirtyFields(() => dirtyFieldKeys(current, saved), persist);
    expect(ok).toBe(false);
    expect(saved.a).toBeUndefined(); // never advanced past the failure
  });
});
