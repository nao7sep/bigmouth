import { describe, expect, it } from "vitest";
import { StorageAdmission } from "@main/storageAdmission.js";

describe("storage snapshot admission", () => {
  it("refuses oversized text or binary snapshots without consuming capacity", () => {
    const admission = new StorageAdmission(1_024);
    expect(admission.reserve(1, ["x".repeat(1_024)])).toBe(false);
    expect(admission.reserve(2, [new Uint8Array(1_024)])).toBe(false);
    expect(admission.reserve(3, ["small"])).toBe(true);
  });

  it("releases a settled reservation once so another packet can be admitted", () => {
    const admission = new StorageAdmission(512);
    expect(admission.reserve(1, ["x".repeat(100)])).toBe(true);
    expect(admission.reserve(2, ["x".repeat(100)])).toBe(false);
    admission.release(1);
    admission.release(1);
    expect(admission.reserve(2, ["x".repeat(100)])).toBe(true);
    expect(admission.reserve(3, ["x".repeat(100)])).toBe(false);
  });

  it("bounds even empty packets and restores capacity when cleared", () => {
    const admission = new StorageAdmission(512);
    let accepted = 0;
    while (accepted < 100 && admission.reserve(accepted, [])) accepted++;
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(100);
    admission.clear();
    for (let id = 0; id < accepted; id++) expect(admission.reserve(id, [])).toBe(true);
    expect(admission.reserve(accepted, [])).toBe(false);
  });

  it("preserves the previous reservation when a replacement cannot fit", () => {
    const admission = new StorageAdmission(512);
    expect(admission.reserve(1, ["x".repeat(100)])).toBe(true);
    expect(admission.replace(1, 2, ["x".repeat(1_024)])).toBe(false);
    expect(admission.reserve(3, ["x".repeat(100)])).toBe(false);
    admission.release(2);
    expect(admission.reserve(3, ["x".repeat(100)])).toBe(false);
    admission.release(1);
    expect(admission.reserve(3, ["x".repeat(100)])).toBe(true);
  });

  it("transfers successful replacement ownership and releases the replaced bytes", () => {
    const admission = new StorageAdmission(512);
    expect(admission.reserve(1, ["x".repeat(100)])).toBe(true);
    expect(admission.replace(1, 2, [])).toBe(true);
    expect(admission.reserve(3, [])).toBe(true);
    admission.release(1);
    expect(admission.reserve(4, ["x".repeat(100)])).toBe(false);
    admission.release(2);
    admission.release(3);
    expect(admission.reserve(4, ["x".repeat(100)])).toBe(true);
  });

  it("accounts for nested arrays, own object fields and Dates without serializing them", () => {
    const admission = new StorageAdmission(1_024);
    const date = new Date("2026-10-23T00:00:00.000Z");
    Object.defineProperty(date, "toJSON", { value: () => { throw new Error("must not serialize"); } });
    expect(admission.reserve(1, [{ dates: [date], text: "small" }])).toBe(true);
    expect(admission.reserve(2, [{ nested: ["x".repeat(512)] }])).toBe(false);
  });

  it("handles cycles and repeated references without repeated traversal", () => {
    const admission = new StorageAdmission(1_024);
    const cyclic: Record<string, unknown> = { text: "x".repeat(100) };
    cyclic.self = cyclic;
    expect(admission.reserve(1, [cyclic, cyclic])).toBe(true);
    admission.clear();
    expect(admission.reserve(2, [{ text: "x".repeat(300), self: cyclic }])).toBe(false);
  });

  it("charges the entire backing buffer of a tiny typed-array or Buffer slice", () => {
    const admission = new StorageAdmission(1_024);
    const buffer = new ArrayBuffer(4_096);
    expect(admission.reserve(1, [new Uint8Array(buffer, 0, 1)])).toBe(false);
    expect(admission.reserve(2, [new DataView(buffer, 1, 1)])).toBe(false);
    expect(admission.reserve(3, [Buffer.from(buffer, 2, 1)])).toBe(false);
    expect(admission.reserve(4, [new Uint8Array(1)])).toBe(true);
  });

  it("counts one backing allocation across shared views and direct references", () => {
    const admission = new StorageAdmission(1_024);
    const buffer = new ArrayBuffer(512);
    expect(admission.reserve(1, [new Uint8Array(buffer, 0, 1), new DataView(buffer, 1, 1), buffer])).toBe(true);
    admission.clear();
    expect(admission.reserve(2, [new Uint8Array(new ArrayBuffer(512), 0, 1), new DataView(new ArrayBuffer(512), 1, 1)])).toBe(false);
  });
});
