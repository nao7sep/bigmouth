import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { NewerFormatError, UnreadableStoreError } from "@main/core/shared/storeFormat.js";
import { QuarantineError } from "@main/core/shared/quarantine.js";

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

describe("assetDir", () => {
  it("refuses a post id that would place the folder outside assets/", () => {
    for (const bad of ["..", ".", "../x", "a/b", "", "a\\b"]) {
      expect(() => assetDir(dataDir, bad)).toThrow(/invalid post id/i);
    }
  });

  it("puts a nanoid's folder directly under assets/", () => {
    expect(assetDir(dataDir, "V1StGXR8_Z5jD")).toBe(path.resolve(dataDir, "assets", "V1StGXR8_Z5jD"));
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
    const listed = listAssets(dataDir, POST).assets;
    expect(listed.map((a) => a.filename)).toEqual(["a.png"]);
    expect(listed[0].size).toBe(3);
  });

  it("leaves no orphaned <stem>-<nanoid>.tmp behind after a successful upload", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    const onDisk = fs.readdirSync(assetDir(dataDir, POST));
    expect(onDisk.sort()).toEqual(["a.png", "meta.json"]);
    expect(onDisk.some((f) => f.toLowerCase().endsWith(".tmp"))).toBe(false);
  });

  it("removes the file, the meta, and the empty dir on the last delete", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    deleteAsset(dataDir, POST, "a.png");
    expect(listAssets(dataDir, POST).assets).toEqual([]);
    expect(fs.existsSync(assetDir(dataDir, POST))).toBe(false);
  });
});

// --- Case-insensitive sibling collisions (macOS/Windows never clobber) -------

describe("replacing an asset", () => {
  it.runIf(process.platform !== "win32")("keeps the permissions of the file it replaces", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    const file = path.join(assetDir(dataDir, POST), "a.png");
    fs.chmodSync(file, 0o640);
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("de"), meta("a.png", 2));
    expect(fs.readFileSync(file, "utf8")).toBe("de");
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });
});

describe("an uploaded copy keeps its source's metadata", () => {
  const source = {
    mode: 0o640,
    atime: new Date("2021-03-04T05:06:07.000Z"),
    mtime: new Date("2021-03-04T05:06:07.000Z"),
  };

  it("keeps the source's modified time, and its permissions where the platform has them", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"), source);
    const stat = fs.statSync(path.join(assetDir(dataDir, POST), "a.png"));
    expect(stat.mtime.toISOString()).toBe("2021-03-04T05:06:07.000Z");
    if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o640);
    // The upload time stays the moment of the upload, apart from the file's time.
    expect(listAssets(dataDir, POST).assets[0].uploadedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("keeps the new source's metadata when it replaces an asset", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("xyz"), meta("a.png"), source);
    const stat = fs.statSync(path.join(assetDir(dataDir, POST), "a.png"));
    expect(stat.mtime.toISOString()).toBe("2021-03-04T05:06:07.000Z");
  });
});

describe("re-uploading an asset's own bytes", () => {
  it("writes nothing and keeps the asset's place and upload time", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    saveAssetFile(dataDir, POST, "b.png", Buffer.from("de"), meta("b.png", 2));
    const metaPath = path.join(assetDir(dataDir, POST), "meta.json");
    const metaBefore = fs.readFileSync(metaPath, "utf8");

    const again = saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), {
      ...meta("a.png"),
      uploadedAt: "2027-01-01T00:00:00.000Z",
    });

    expect(again).toEqual({ asset: meta("a.png"), changed: false });
    expect(fs.readFileSync(metaPath, "utf8")).toBe(metaBefore);
    expect(listAssets(dataDir, POST).assets.map((a) => a.filename)).toEqual(["a.png", "b.png"]);
  });

  it("replaces an asset whose bytes differ", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    const again = saveAssetFile(dataDir, POST, "a.png", Buffer.from("xyz"), meta("a.png"));
    expect(again.changed).toBe(true);
    expect(fs.readFileSync(path.join(assetDir(dataDir, POST), "a.png"), "utf8")).toBe("xyz");
  });
});

describe("saveAssetFile disambiguates case-only filename collisions", () => {
  it("keeps both files when a new name differs only in case from an existing one", () => {
    saveAssetFile(dataDir, POST, "Photo.png", Buffer.from("abc"), meta("Photo.png"));
    const { asset: stored } = saveAssetFile(dataDir, POST, "photo.png", Buffer.from("de"), meta("photo.png", 2));

    // The second upload gets a distinct, human-readable name (casing preserved).
    expect(stored.filename).toBe("photo (1).png");

    // Both survive on disk as separate files...
    const dir = assetDir(dataDir, POST);
    const onDisk = fs.readdirSync(dir).filter((f) => f !== "meta.json" && !f.startsWith("."));
    expect(onDisk.sort()).toEqual(["Photo.png", "photo (1).png"].sort());

    // ...and meta.json records both, exactly as written to disk.
    const listed = listAssets(dataDir, POST).assets;
    expect(listed.map((a) => a.filename).sort()).toEqual(["Photo.png", "photo (1).png"].sort());
    expect(listed.find((a) => a.filename === "Photo.png")?.size).toBe(3);
    expect(listed.find((a) => a.filename === "photo (1).png")?.size).toBe(2);
  });

  it("replaces in place on an exact same-name (case-identical) re-upload", () => {
    saveAssetFile(dataDir, POST, "photo.png", Buffer.from("abc"), meta("photo.png"));
    const { asset: stored } = saveAssetFile(dataDir, POST, "photo.png", Buffer.from("de"), meta("photo.png", 2));

    expect(stored.filename).toBe("photo.png");
    const listed = listAssets(dataDir, POST).assets;
    expect(listed.map((a) => a.filename)).toEqual(["photo.png"]);
    expect(listed[0].size).toBe(2); // overwritten, not duplicated
  });
});

// --- Crash recovery: a derived cache reconciled against the files -----------

describe("listAssets self-heals against the files on disk", () => {
  it("recovers an asset file whose meta.json is missing (interrupted first upload)", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    // Simulate a crash after the file was installed but before meta was written.
    fs.unlinkSync(path.join(assetDir(dataDir, POST), "meta.json"));

    // Old behaviour threw here; now the file is projected back into the list.
    const listed = listAssets(dataDir, POST).assets;
    expect(listed.map((a) => a.filename)).toEqual(["a.png"]);
    expect(listed[0].size).toBe(3); // size recovered from the file itself
  });

  it("drops a cached entry whose file is gone (interrupted delete)", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    saveAssetFile(dataDir, POST, "b.png", Buffer.from("de"), meta("b.png", 2));
    // Simulate a crash after the file was unlinked but before meta was rewritten.
    fs.unlinkSync(path.join(assetDir(dataDir, POST), "a.png"));

    const listed = listAssets(dataDir, POST).assets;
    expect(listed.map((a) => a.filename)).toEqual(["b.png"]);
  });

  it("ignores dotfiles (in-flight temp files) when reconciling", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    fs.writeFileSync(path.join(assetDir(dataDir, POST), ".upload-tmp-123"), "partial");

    expect(listAssets(dataDir, POST).assets.map((a) => a.filename)).toEqual(["a.png"]);
  });

  it("ignores a crash-orphaned <stem>-<nanoid>.tmp (current atomic-write shape, no leading dot)", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    fs.writeFileSync(path.join(assetDir(dataDir, POST), "photo-V1StGXR8_Z5jD.tmp"), "partial");

    expect(listAssets(dataDir, POST).assets.map((a) => a.filename)).toEqual(["a.png"]);
  });

  // content-lifecycle-conventions: a missing time is not made up. A file's
  // modified time is when it was last written — a copy or a git checkout resets
  // it — so it is not an upload time, shown or stored.
  it("gives a file it has no record of no upload time, and never stores one", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    const dir = assetDir(dataDir, POST);
    fs.unlinkSync(path.join(dir, "meta.json"));

    expect(listAssets(dataDir, POST).assets[0]).toEqual({ filename: "a.png", size: 3 });

    // The next upload and the next delete write the list back to meta.json.
    saveAssetFile(dataDir, POST, "b.png", Buffer.from("de"), meta("b.png", 2));
    const afterUpload = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8")).assets as AssetMeta[];
    expect(afterUpload.find((a) => a.filename === "a.png")).toEqual({ filename: "a.png", size: 3 });
    expect(afterUpload.find((a) => a.filename === "b.png")?.uploadedAt).toBe("2026-01-01T00:00:00.000Z");

    fs.writeFileSync(path.join(dir, "c.png"), "xyz");
    deleteAsset(dataDir, POST, "b.png");
    const afterDelete = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8")).assets as AssetMeta[];
    expect(afterDelete).toEqual([
      { filename: "a.png", size: 3 },
      { filename: "c.png", size: 3 },
    ]);
  });
});

// store-recovery-conventions: meta.json holds upload times nothing can rebuild,
// so an unusable one is moved aside before the files are listed without it.
describe("an unusable meta.json is moved aside", () => {
  const dir = () => assetDir(dataDir, POST);
  const invalidFiles = () => fs.readdirSync(dir()).filter((name) => name.endsWith(".invalid"));

  it.each([
    ["is not JSON", "{ not json"],
    ["has an assets key that is not a list", JSON.stringify({ formatVersion: 1, assets: {} })],
    ["holds an entry that is not an asset record", JSON.stringify({ formatVersion: 1, assets: [null] })],
    ["holds an entry with a wrong field", JSON.stringify({ formatVersion: 1, assets: [{ filename: "a.png", size: "3" }] })],
  ])("keeps the bytes of one that %s and lists the files from the folder", (_name, body) => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    fs.writeFileSync(path.join(dir(), "meta.json"), body);

    const listing = listAssets(dataDir, POST);

    expect(listing.assets).toEqual([{ filename: "a.png", size: 3 }]);
    expect(invalidFiles()).toHaveLength(1);
    const [moved] = invalidFiles();
    expect(moved).toMatch(/^meta-\d{8}-\d{6}-\d{3}-utc\.invalid$/);
    expect(fs.readFileSync(path.join(dir(), moved), "utf8")).toBe(body);
    expect(listing.movedAside).toEqual({ path: path.join(dir(), "meta.json"), movedTo: path.join(dir(), moved) });
    // Absent now, so nothing is written until the next upload or delete.
    expect(fs.existsSync(path.join(dir(), "meta.json"))).toBe(false);
    expect(listAssets(dataDir, POST).movedAside).toBeUndefined();
  });

  it("writes nothing when the move fails, leaving meta.json and the files as they were", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    const metaPath = path.join(dir(), "meta.json");
    fs.writeFileSync(metaPath, "{ not json");
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    try {
      expect(() => saveAssetFile(dataDir, POST, "b.png", Buffer.from("de"), meta("b.png", 2))).toThrow(QuarantineError);
      expect(() => deleteAsset(dataDir, POST, "a.png")).toThrow(QuarantineError);
      expect(() => listAssets(dataDir, POST)).toThrow(QuarantineError);
    } finally {
      renameSpy.mockRestore();
    }
    expect(fs.readFileSync(metaPath, "utf8")).toBe("{ not json");
    expect(fs.readdirSync(dir()).sort()).toEqual(["a.png", "meta.json"]);
  });
});

// store-recovery-conventions: meta.json's format version.
describe("asset metadata format version", () => {
  const metaFile = () => path.join(assetDir(dataDir, POST), "meta.json");

  it("writes this build's format version and reads the list back", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    expect(JSON.parse(fs.readFileSync(metaFile(), "utf-8"))).toEqual({ formatVersion: 1, assets: [meta("a.png")] });
    expect(listAssets(dataDir, POST).assets).toEqual([meta("a.png")]);
  });

  it("reads a meta.json without its format version as this build's format", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    fs.writeFileSync(metaFile(), JSON.stringify({ assets: [{ ...meta("a.png"), width: 7 }] }));
    expect(listAssets(dataDir, POST).assets).toEqual([{ ...meta("a.png"), width: 7 }]);
  });

  it("lists from the files over a meta.json it could not read, refuses writes, and never moves it", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    // A directory where the file should be fails the read itself, as a permission error does.
    fs.rmSync(metaFile());
    fs.mkdirSync(metaFile());

    expect(listAssets(dataDir, POST)).toEqual({ assets: [{ filename: "a.png", size: 3 }] });
    expect(() => saveAssetFile(dataDir, POST, "b.png", Buffer.from("de"), meta("b.png", 2))).toThrow(UnreadableStoreError);
    expect(() => deleteAsset(dataDir, POST, "a.png")).toThrow(UnreadableStoreError);
    expect(fs.statSync(metaFile()).isDirectory()).toBe(true);
    expect(fs.readdirSync(assetDir(dataDir, POST)).sort()).toEqual(["a.png", "meta.json"]);
  });

  it("lists from the files over a meta.json a newer version wrote, refuses writes, and leaves it byte-identical", () => {
    saveAssetFile(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    const body = JSON.stringify({ formatVersion: 2, items: [] });
    fs.writeFileSync(metaFile(), body);

    expect(listAssets(dataDir, POST).assets).toEqual([{ filename: "a.png", size: 3 }]);
    expect(() => saveAssetFile(dataDir, POST, "b.png", Buffer.from("de"), meta("b.png", 2))).toThrow(NewerFormatError);
    expect(() => deleteAsset(dataDir, POST, "a.png")).toThrow(NewerFormatError);

    expect(fs.readFileSync(metaFile(), "utf-8")).toBe(body);
    expect(fs.readdirSync(assetDir(dataDir, POST)).sort()).toEqual(["a.png", "meta.json"]);
  });
});
