import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listAssets,
  saveAssetFile,
  deleteAsset,
  sanitizeFilename,
  safeResolveUnder,
  assetDir,
  type AssetMeta,
} from "@main/core/services/assetStore.js";

let dataDir: string;
const POST = "post-1";

function meta(filename: string, size = 3): AssetMeta {
  return { filename, size, uploadedAt: "2026-01-01T00:00:00.000Z" };
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-assets-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// --- Path traversal (the security boundary the README promises) -------------

describe("safeResolveUnder", () => {
  it("rejects paths that escape the root", () => {
    const root = assetDir(dataDir, POST);
    expect(() => safeResolveUnder(root, "..", "..", "etc", "passwd")).toThrow(/escape/i);
    expect(() => safeResolveUnder(root, "/etc/passwd")).toThrow(/escape/i);
    expect(() => safeResolveUnder(root, "../sibling")).toThrow(/escape/i);
  });

  it("resolves a plain name under the root", () => {
    const root = assetDir(dataDir, POST);
    expect(safeResolveUnder(root, "image.png")).toBe(path.join(root, "image.png"));
  });
});

describe("sanitizeFilename", () => {
  it("strips path components and disallowed characters", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("a b/c?.png")).toBe("c_.png");
    expect(sanitizeFilename("ok-name_1.jpg")).toBe("ok-name_1.jpg");
  });
});

// --- Save / list / delete round-trip ----------------------------------------

describe("saveAssetFile / listAssets / deleteAsset", () => {
  it("round-trips an asset and its metadata", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    const listed = listAssets(dataDir, POST);
    expect(listed.map((a) => a.filename)).toEqual(["a.png"]);
    expect(listed[0].size).toBe(3);
  });

  it("removes the file, the meta, and the empty dir on the last delete", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    deleteAsset(dataDir, POST, "a.png");
    expect(listAssets(dataDir, POST)).toEqual([]);
    expect(fs.existsSync(assetDir(dataDir, POST))).toBe(false);
  });
});

// --- Crash recovery: a derived cache reconciled against the files -----------

describe("listAssets self-heals against the files on disk", () => {
  it("recovers an asset file whose meta.json is missing (interrupted first upload)", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    // Simulate a crash after the file was installed but before meta was written.
    fs.unlinkSync(path.join(assetDir(dataDir, POST), "meta.json"));

    // Old behaviour threw here; now the file is projected back into the list.
    const listed = listAssets(dataDir, POST);
    expect(listed.map((a) => a.filename)).toEqual(["a.png"]);
    expect(listed[0].size).toBe(3); // size recovered from the file itself
  });

  it("drops a cached entry whose file is gone (interrupted delete)", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    saveAssetFile(dataDir, POST, "b.png", Buffer.from("de"), meta("b.png", 2));
    // Simulate a crash after the file was unlinked but before meta was rewritten.
    fs.unlinkSync(path.join(assetDir(dataDir, POST), "a.png"));

    const listed = listAssets(dataDir, POST);
    expect(listed.map((a) => a.filename)).toEqual(["b.png"]);
  });

  it("ignores dotfiles (in-flight temp files) when reconciling", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    fs.writeFileSync(path.join(assetDir(dataDir, POST), ".upload-tmp-123"), "partial");

    expect(listAssets(dataDir, POST).map((a) => a.filename)).toEqual(["a.png"]);
  });

  it("tolerates a corrupt meta.json by rebuilding from the files", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    fs.writeFileSync(path.join(assetDir(dataDir, POST), "meta.json"), "{ not json");

    expect(listAssets(dataDir, POST).map((a) => a.filename)).toEqual(["a.png"]);
  });
});
