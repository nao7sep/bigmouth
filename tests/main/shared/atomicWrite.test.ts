// Proves writeFileAtomic's contract: the content lands at the target, no
// orphaned sibling temp file is left behind, and an existing file is replaced
// in full (the rename swaps the new content over the old, never a truncation).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

  it("writes the content to the target", () => {
    const target = path.join(dir, "data.json");
    writeFileAtomic(target, "hello world");
    expect(fs.readFileSync(target, "utf-8")).toBe("hello world");
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
});
