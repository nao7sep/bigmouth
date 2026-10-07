// Proves writeFileAtomic's contract: the content lands at the target, no
// orphaned sibling temp file is left behind, and an existing file is replaced
// in full (the rename swaps the new content over the old, never a truncation).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "@main/core/shared/atomicWrite.js";

describe("writeFileAtomic", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-atomic-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(process.platform !== "win32")("tightens explicit permissions even when content is unchanged", () => {
    const target = path.join(dir, "secret.json");
    fs.writeFileSync(target, "same", { mode: 0o644 });
    expect(writeFileAtomic(target, "same", 0o600)).toBe(false);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("does not overwrite or clean up a colliding stage", () => {
    const target = path.join(dir, "data.json");
    const realOpen = fs.openSync.bind(fs);
    let collision = "";
    const spy = vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      if (flags === "wx") {
        collision = String(file);
        fs.writeFileSync(file, "owned by another writer");
      }
      return realOpen(file, flags, mode);
    });
    try { expect(() => writeFileAtomic(target, "new")).toThrow(); }
    finally { spy.mockRestore(); }
    expect(fs.readFileSync(collision, "utf8")).toBe("owned by another writer");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("writes the content to the target", () => {
    const target = path.join(dir, "data.json");
    writeFileAtomic(target, "hello world");
    expect(fs.readFileSync(target, "utf-8")).toBe("hello world");
  });

  it.skipIf(process.platform === "win32")("keeps an ordinary stage private until its bytes are complete", () => {
    const target = path.join(dir, "ordinary.json");
    fs.writeFileSync(target, "before", { mode: 0o640 });
    const write = fs.writeFileSync;
    const during: number[] = [];
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, ...args) => {
      if (typeof file === "number") during.push(fs.fstatSync(file).mode & 0o777);
      return write(file, ...args);
    });
    try { writeFileAtomic(target, "after"); } finally { spy.mockRestore(); }
    expect(during).toEqual([0o600]);
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  });

  it("leaves no orphaned temp file in the target directory", () => {
    const target = path.join(dir, "data.json");
    writeFileAtomic(target, "payload");
    const entries = fs.readdirSync(dir);
    expect(entries).toEqual(["data.json"]);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("overwrites an existing file with the new content", () => {
    const target = path.join(dir, "data.json");
    writeFileAtomic(target, "old content that is quite long");
    writeFileAtomic(target, "new");
    expect(fs.readFileSync(target, "utf-8")).toBe("new");
    // The replacement must be atomic, leaving exactly the target and nothing else.
    expect(fs.readdirSync(dir)).toEqual(["data.json"]);
  });

  it("skips a write of the bytes the file already holds, leaving the file untouched", () => {
    const target = path.join(dir, "data.json");
    fs.writeFileSync(target, "same");
    const past = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(target, past, past);
    const renameSpy = vi.spyOn(fs, "renameSync");
    try {
      expect(writeFileAtomic(target, "same")).toBe(false);
      expect(writeFileAtomic(target, Buffer.from("same"))).toBe(false);
      expect(renameSpy).not.toHaveBeenCalled();
    } finally {
      renameSpy.mockRestore();
    }
    expect(fs.statSync(target).mtime.toISOString()).toBe(past.toISOString());
    expect(writeFileAtomic(target, "changed")).toBe(true);
    expect(fs.readFileSync(target, "utf-8")).toBe("changed");
  });

  it("removes its temp and rethrows the original failure when the install fails", () => {
    const target = path.join(dir, "data.json");
    fs.writeFileSync(target, "original");
    const failure = new Error("rename refused");
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw failure;
    });
    try {
      expect(() => writeFileAtomic(target, "new")).toThrow(failure);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(dir)).toEqual(["data.json"]);
    expect(fs.readFileSync(target, "utf-8")).toBe("original");
  });

  it("rethrows the original failure even when removing the temp also fails", () => {
    const target = path.join(dir, "data.json");
    const failure = new Error("rename refused");
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw failure;
    });
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
      throw new Error("cleanup refused");
    });
    try {
      expect(() => writeFileAtomic(target, "new")).toThrow(failure);
    } finally {
      renameSpy.mockRestore();
      rmSpy.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")("creates the file at the requested mode", () => {
    // The mode is applied at creation, so the content never exists at a looser
    // default for even an instant (used for the 0600 secrets file).
    const target = path.join(dir, "secret.json");
    writeFileAtomic(target, "s3cr3t", 0o600);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform !== "win32")("keeps the permissions of the file it replaces", () => {
    const target = path.join(dir, "data.json");
    fs.writeFileSync(target, "old");
    fs.chmodSync(target, 0o640);
    writeFileAtomic(target, "new");
    expect(fs.readFileSync(target, "utf-8")).toBe("new");
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  });

  it.runIf(process.platform !== "win32")("applies an explicit mode over the replaced file's permissions", () => {
    const target = path.join(dir, "secret.json");
    fs.writeFileSync(target, "old");
    fs.chmodSync(target, 0o644);
    writeFileAtomic(target, "new", 0o600);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("names the temp file <stem>-<nanoid>.tmp in the target's own directory", () => {
    // Derived-filename grammar: the discriminator is hyphen-joined into the
    // target's stem, never dot-appended after the full filename.
    const target = path.join(dir, "data.json");
    const realRename = fs.renameSync.bind(fs);
    let tempPathSeen = "";
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      tempPathSeen = from as string;
      return realRename(from, to);
    });

    writeFileAtomic(target, "hi");
    spy.mockRestore();

    expect(path.dirname(tempPathSeen)).toBe(dir);
    expect(path.basename(tempPathSeen)).toMatch(/^data-[A-Za-z0-9_-]+\.tmp$/);
  });
});
