import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  listAssets,
  installAsset,
  stagingDir,
  sweepStaging,
  deleteAsset,
  sanitizeFilename,
  safeResolveUnder,
  assetDir,
  visitRecordedHashes,
  type AssetMeta,
  type AssetSourceMetadata,
  type StagedUpload,
} from "@main/core/services/assetStore.js";
import { NewerFormatError, UnreadableStoreError } from "@main/core/shared/storeFormat.js";
import { QuarantineError } from "@main/core/shared/quarantine.js";

let dataDir: string;
const POST = "post-1";

function meta(filename: string, size = 3): AssetMeta {
  return { filename, size, uploadedAt: "2026-01-01T00:00:00.000Z" };
}

/** The SHA-256 a listing tells for these bytes. */
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

let stagedCount = 0;

/** Writes `bytes` to a staged upload, as the main process does while an upload streams in. */
function stage(bytes: Buffer): StagedUpload {
  const dir = stagingDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const name = `staged${++stagedCount}.part`;
  fs.writeFileSync(path.join(dir, name), bytes, { mode: 0o600 });
  return { name, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

/** Stages `bytes` and installs them, as an upload does. */
function install(dir: string, postId: string, filename: string, bytes: Buffer, details: AssetMeta, source?: AssetSourceMetadata) {
  return installAsset(dir, postId, filename, stage(bytes), details, source);
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

describe("installAsset / listAssets / deleteAsset", () => {
  it("keeps an unreadable sibling independent from accessible uploads and deletion", () => {
    const recorded = { ...meta("blocked.png"), width: 100, height: 200, hasMetadata: true };
    install(dataDir, POST, "blocked.png", Buffer.from("abc"), recorded);
    install(dataDir, POST, "accessible.png", Buffer.from("abc"), meta("accessible.png"));
    const blocked = path.join(assetDir(dataDir, POST), "blocked.png");
    // A modified time other than the recorded one makes the listing read the file.
    fs.utimesSync(blocked, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    const open = fs.openSync;
    const fail = vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      if (String(file) === blocked) throw new Error("injected unreadable attachment");
      return open(file, flags, mode);
    });
    try {
      expect(listAssets(dataDir, POST).assets.find((a) => a.filename === "blocked.png")).toEqual({ filename: "blocked.png", size: 3 });
      install(dataDir, POST, "new.png", Buffer.from("new"), meta("new.png"));
      expect(() => deleteAsset(dataDir, POST, "accessible.png")).not.toThrow();
      expect(fs.existsSync(path.join(assetDir(dataDir, POST), "accessible.png"))).toBe(false);
      expect(fs.existsSync(blocked)).toBe(true);
    } finally { fail.mockRestore(); }
    expect(listAssets(dataDir, POST).assets.find((a) => a.filename === "blocked.png")).toEqual({ ...recorded, contentHash: sha("abc") });
  });

  it("keeps upload facts when identical bytes are copied to a new file identity", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), { ...meta("a.png"), width: 100 });
    const file = path.join(assetDir(dataDir, POST), "a.png");
    fs.copyFileSync(file, file + ".copy");
    fs.renameSync(file + ".copy", file);
    expect(listAssets(dataDir, POST).assets).toEqual([{ ...meta("a.png"), width: 100, contentHash: sha("abc") }]);
  });

  it("does not keep old upload facts after an interrupted same-name replacement", () => {
    install(dataDir, POST, "a.png", Buffer.from("old"), { ...meta("a.png"), width: 100, height: 200, hasMetadata: true });
    const dir = assetDir(dataDir, POST);
    const oldMeta = fs.readFileSync(path.join(dir, "meta.json"));
    install(dataDir, POST, "a.png", Buffer.from("new bytes"), { ...meta("a.png", 9), width: 1, height: 2 });
    // Crash between binary publication and metadata publication leaves the prior sidecar.
    fs.writeFileSync(path.join(dir, "meta.json"), oldMeta);
    expect(listAssets(dataDir, POST).assets).toEqual([{ filename: "a.png", size: 9, contentHash: sha("new bytes") }]);
    expect(install(dataDir, POST, "a.png", Buffer.from("new bytes"), meta("a.png", 9)).asset).toEqual({ filename: "a.png", size: 9, contentHash: sha("new bytes") });
  });

  it("round-trips an asset and its metadata", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    const listed = listAssets(dataDir, POST).assets;
    expect(listed.map((a) => a.filename)).toEqual(["a.png"]);
    expect(listed[0].size).toBe(3);
  });

  it("leaves no orphaned <stem>-<nanoid>.tmp behind after a successful upload", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    const onDisk = fs.readdirSync(assetDir(dataDir, POST));
    expect(onDisk.sort()).toEqual(["a.png", "meta.json"]);
    expect(onDisk.some((f) => f.toLowerCase().endsWith(".tmp"))).toBe(false);
  });

  it("removes the file, the meta, and the empty dir on the last delete", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    deleteAsset(dataDir, POST, "a.png");
    expect(listAssets(dataDir, POST).assets).toEqual([]);
    expect(fs.existsSync(assetDir(dataDir, POST))).toBe(false);
  });
});

// --- Case-insensitive sibling collisions (macOS/Windows never clobber) -------

describe("replacing an asset", () => {
  it.runIf(process.platform !== "win32")("keeps the permissions of the file it replaces", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    const file = path.join(assetDir(dataDir, POST), "a.png");
    fs.chmodSync(file, 0o640);
    install(dataDir, POST, "a.png", Buffer.from("de"), meta("a.png", 2));
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
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"), source);
    const stat = fs.statSync(path.join(assetDir(dataDir, POST), "a.png"));
    expect(stat.mtime.toISOString()).toBe("2021-03-04T05:06:07.000Z");
    // Windows has no POSIX permission bits to carry over.
    if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o640);
    // The upload time stays the moment of the upload, apart from the file's time.
    expect(listAssets(dataDir, POST).assets[0].uploadedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("keeps the new source's metadata when it replaces an asset", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    install(dataDir, POST, "a.png", Buffer.from("xyz"), meta("a.png"), source);
    const stat = fs.statSync(path.join(assetDir(dataDir, POST), "a.png"));
    expect(stat.mtime.toISOString()).toBe("2021-03-04T05:06:07.000Z");
  });
});

describe("re-uploading an asset's own bytes", () => {
  it("writes nothing and keeps the asset's place and upload time", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    install(dataDir, POST, "b.png", Buffer.from("de"), meta("b.png", 2));
    const metaPath = path.join(assetDir(dataDir, POST), "meta.json");
    const metaBefore = fs.readFileSync(metaPath, "utf8");

    const again = install(dataDir, POST, "a.png", Buffer.from("abc"), {
      ...meta("a.png"),
      uploadedAt: "2027-01-01T00:00:00.000Z",
    });

    expect(again).toEqual({ asset: { ...meta("a.png"), contentHash: sha("abc") }, changed: false });
    expect(fs.readFileSync(metaPath, "utf8")).toBe(metaBefore);
    expect(listAssets(dataDir, POST).assets.map((a) => a.filename)).toEqual(["a.png", "b.png"]);
  });

  it("replaces an asset whose bytes differ", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    const again = install(dataDir, POST, "a.png", Buffer.from("xyz"), meta("a.png"));
    expect(again.changed).toBe(true);
    expect(fs.readFileSync(path.join(assetDir(dataDir, POST), "a.png"), "utf8")).toBe("xyz");
  });
});

describe("installing a staged upload", () => {
  const staged = () => fs.readdirSync(stagingDir(dataDir));

  it("renames the staged file into place, with the exact bytes and its hash recorded", () => {
    const bytes = Buffer.from([0, 1, 2, 0xff, 0x0d, 0x0a]);
    const upload = stage(bytes);
    installAsset(dataDir, POST, "a.bin", upload, meta("a.bin", 6));
    const file = path.join(assetDir(dataDir, POST), "a.bin");
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(staged()).toEqual([]);
    const [record] = JSON.parse(fs.readFileSync(path.join(assetDir(dataDir, POST), "meta.json"), "utf8")).assets;
    expect(record).toMatchObject({ size: 6, contentHash: upload.sha256, mtimeMs: fs.statSync(file).mtimeMs });
  });

  it.runIf(process.platform !== "win32")("publishes a new file with the ordinary mode, not the stage's private one", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    expect(fs.statSync(path.join(assetDir(dataDir, POST), "a.png")).mode & 0o777).toBe(0o666 & ~process.umask());
  });

  it("treats the same bytes under the same name as no change, without reading the installed file", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    const file = path.join(assetDir(dataDir, POST), "a.png");
    const upload = stage(Buffer.from("abc"));
    const opened = vi.spyOn(fs, "openSync");
    const read = vi.spyOn(fs, "readFileSync");
    try {
      expect(installAsset(dataDir, POST, "a.png", upload, meta("a.png")).changed).toBe(false);
      expect(opened.mock.calls.some(([target]) => String(target) === file)).toBe(false);
      expect(read.mock.calls.some(([target]) => String(target) === file)).toBe(false);
    } finally {
      opened.mockRestore();
      read.mockRestore();
    }
    // The stage is left for the upload that owns it to remove.
    expect(staged()).toEqual([upload.name]);
  });

  it("compares a file it holds no hash for by hashing it, so its own bytes are still no change", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    fs.rmSync(path.join(assetDir(dataDir, POST), "meta.json"));
    expect(install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png")).changed).toBe(false);
    expect(install(dataDir, POST, "a.png", Buffer.from("xyz"), meta("a.png")).changed).toBe(true);
  });

  it("refuses a staged name outside the staging grammar", () => {
    expect(() => installAsset(dataDir, POST, "a.png", { name: "../../a.part", sha256: "", size: 0 }, meta("a.png"))).toThrow(/staged upload name/);
    expect(fs.existsSync(assetDir(dataDir, POST))).toBe(false);
  });
});

// Phase B keys derived images by this hash, so an asset's hash is trusted only
// while the file is as it was when hashed.
describe("an asset's recorded hash", () => {
  const file = () => path.join(assetDir(dataDir, POST), "a.png");

  it("is trusted without reading the file while its size and modified time are the recorded ones", () => {
    // The source's time, in whole milliseconds, so the test can put it back exactly.
    const mtime = new Date("2021-03-04T05:06:07.000Z");
    install(dataDir, POST, "a.png", Buffer.from("abc"), { ...meta("a.png"), width: 4, height: 5 }, { mode: 0o644, atime: mtime, mtime });
    // Different bytes of the same size, with the recorded time put back: only a
    // read could tell, and the listing does not read.
    fs.writeFileSync(file(), "xyz");
    fs.utimesSync(file(), mtime, mtime);
    const opened = vi.spyOn(fs, "openSync");
    try {
      expect(listAssets(dataDir, POST).assets).toEqual([{ ...meta("a.png"), width: 4, height: 5, contentHash: sha("abc") }]);
      expect(opened.mock.calls.some(([target]) => String(target) === file())).toBe(false);
    } finally { opened.mockRestore(); }
  });

  it("is checked again by reading the file when its modified time differs, and kept when the bytes match", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), { ...meta("a.png"), width: 4, height: 5 });
    const moved = new Date("2022-02-02T02:02:02.000Z");
    fs.utimesSync(file(), moved, moved);
    expect(listAssets(dataDir, POST).assets).toEqual([{ ...meta("a.png"), width: 4, height: 5, contentHash: sha("abc") }]);

    // The next write records the new time, so the file is trusted again without a read.
    install(dataDir, POST, "b.png", Buffer.from("de"), meta("b.png", 2));
    const record = JSON.parse(fs.readFileSync(path.join(assetDir(dataDir, POST), "meta.json"), "utf8")).assets[0];
    expect(record.mtimeMs).toBe(moved.getTime());
  });

  it("is replaced when the file changed outside the app, dropping the upload facts it described", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), { ...meta("a.png"), width: 4, height: 5 });
    fs.writeFileSync(file(), "a longer replacement");
    expect(listAssets(dataDir, POST).assets).toEqual([{ filename: "a.png", size: 20, contentHash: sha("a longer replacement") }]);
    // The same new bytes uploaded under the name are then no change.
    expect(install(dataDir, POST, "a.png", Buffer.from("a longer replacement"), meta("a.png", 20)).changed).toBe(false);
  });

  it("is checked again when a record from before modified times were kept has none", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), { ...meta("a.png"), width: 4 });
    const metaPath = path.join(assetDir(dataDir, POST), "meta.json");
    const stored = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    delete stored.assets[0].mtimeMs;
    fs.writeFileSync(metaPath, JSON.stringify(stored));
    expect(listAssets(dataDir, POST).assets).toEqual([{ ...meta("a.png"), width: 4, contentHash: sha("abc") }]);
    fs.writeFileSync(file(), "xyz");
    expect(listAssets(dataDir, POST).assets).toEqual([{ filename: "a.png", size: 3, contentHash: sha("xyz") }]);
  });
});

describe("hashes for thumbnails", () => {
  it("hashes an image found without a record, so it can have a thumbnail, but no other file", () => {
    const dir = assetDir(dataDir, POST);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "found.png"), "abc");
    fs.writeFileSync(path.join(dir, "found.mov"), "a long video");
    expect(listAssets(dataDir, POST).assets).toEqual([
      { filename: "found.mov", size: 12 },
      { filename: "found.png", size: 3, contentHash: sha("abc") },
    ]);
  });

  it("records whether an image is animated with its other details", () => {
    install(dataDir, POST, "moving.gif", Buffer.from("gif"), { ...meta("moving.gif"), width: 8, height: 6, animated: true });
    expect(listAssets(dataDir, POST).assets).toEqual([{ ...meta("moving.gif"), width: 8, height: 6, animated: true, contentHash: sha("gif") }]);
  });

  it("visits every hash a workspace's meta.json files record", async () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    install(dataDir, "post-2", "b.png", Buffer.from("de"), meta("b.png", 2));
    fs.mkdirSync(path.join(dataDir, "assets", "post-3"));
    fs.writeFileSync(path.join(dataDir, "assets", "post-3", "meta.json"), "{ not json");
    const seen: string[] = [];
    await visitRecordedHashes(dataDir, (hash) => seen.push(hash));
    expect(seen.sort()).toEqual([sha("abc"), sha("de")].sort());
  });

  it("visits nothing in a workspace without assets, and throws for one it cannot reach", async () => {
    const seen: string[] = [];
    await visitRecordedHashes(dataDir, (hash) => seen.push(hash));
    expect(seen).toEqual([]);
    await expect(visitRecordedHashes(path.join(dataDir, "unmounted"), () => {})).rejects.toThrow();
  });
});

describe("sweepStaging", () => {
  const dir = () => stagingDir(dataDir);
  const longAgo = new Date("2020-01-01T00:00:00.000Z");

  it("removes staged uploads an earlier launch left, and keeps this launch's and anything else", () => {
    fs.mkdirSync(dir(), { recursive: true });
    for (const name of ["left.part", "notes.txt", "live.part"]) fs.writeFileSync(path.join(dir(), name), "x");
    fs.utimesSync(path.join(dir(), "left.part"), longAgo, longAgo);
    fs.utimesSync(path.join(dir(), "notes.txt"), longAgo, longAgo);

    expect(sweepStaging(dataDir)).toBe(1);
    expect(fs.readdirSync(dir()).sort()).toEqual(["live.part", "notes.txt"]);
  });

  it("does nothing for a workspace that never staged an upload", () => {
    expect(sweepStaging(dataDir)).toBe(0);
    expect(fs.existsSync(dir())).toBe(false);
  });
});

describe("installAsset disambiguates case-only filename collisions", () => {
  it("keeps both files when a new name differs only in case from an existing one", () => {
    install(dataDir, POST, "Photo.png", Buffer.from("abc"), meta("Photo.png"));
    const { asset: stored } = install(dataDir, POST, "photo.png", Buffer.from("de"), meta("photo.png", 2));

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
    install(dataDir, POST, "photo.png", Buffer.from("abc"), meta("photo.png"));
    const { asset: stored } = install(dataDir, POST, "photo.png", Buffer.from("de"), meta("photo.png", 2));

    expect(stored.filename).toBe("photo.png");
    const listed = listAssets(dataDir, POST).assets;
    expect(listed.map((a) => a.filename)).toEqual(["photo.png"]);
    expect(listed[0].size).toBe(2); // overwritten, not duplicated
  });
});

// --- Windows filesystem: the sanitized names hold on a real NTFS disk -------
// Elsewhere these run against a filesystem that accepts every name, so they
// would prove nothing; they run on the Windows PC.

describe("asset names on Windows", () => {
  const onWindows = it.runIf(process.platform === "win32");

  onWindows("stores names Windows reserves or trims under their sanitized names, and reads them back", () => {
    const cases: [raw: string, stored: string][] = [
      ["CON.backup.txt", "_CON.backup.txt"],
      ["aux", "_aux"],
      ["lpt1.png", "_lpt1.png"],
      ["name.", "name"],
      ["trailing space ", "trailing space"],
      ['a:b?"c.png', "a_b__c.png"],
    ];
    const dir = assetDir(dataDir, POST);
    for (const [index, [raw, stored]] of cases.entries()) {
      const name = sanitizeFilename(raw);
      expect(name).toBe(stored);
      const bytes = Buffer.from(`bytes ${index}`);
      expect(install(dataDir, POST, name, bytes, meta(name, bytes.length)).asset.filename).toBe(stored);
      expect(fs.readFileSync(path.join(dir, stored)).equals(bytes)).toBe(true);
    }

    // The directory lists each file under exactly the stored spelling, and the list matches it.
    const onDisk = fs.readdirSync(dir).filter((f) => f !== "meta.json");
    expect(onDisk.sort()).toEqual(cases.map(([, stored]) => stored).sort());
    expect(listAssets(dataDir, POST).assets.map((a) => a.filename).sort()).toEqual(onDisk.sort());

    deleteAsset(dataDir, POST, "_CON.backup.txt");
    expect(fs.existsSync(path.join(dir, "_CON.backup.txt"))).toBe(false);
    expect(listAssets(dataDir, POST).assets).toHaveLength(cases.length - 1);
  });

  onWindows("keeps both files when a re-upload differs only in case", () => {
    const dir = assetDir(dataDir, POST);
    install(dataDir, POST, "Photo.png", Buffer.from("abc"), meta("Photo.png"));
    // NTFS resolves either spelling to the one file, so writing the second
    // spelling as-is would replace the first.
    expect(fs.readFileSync(path.join(dir, "photo.png"), "utf8")).toBe("abc");

    expect(install(dataDir, POST, "photo.png", Buffer.from("de"), meta("photo.png", 2)).asset.filename)
      .toBe("photo (1).png");
    expect(install(dataDir, POST, "PHOTO.PNG", Buffer.from("f"), meta("PHOTO.PNG", 1)).asset.filename)
      .toBe("PHOTO (2).PNG");

    expect(fs.readFileSync(path.join(dir, "Photo.png"), "utf8")).toBe("abc");
    expect(fs.readFileSync(path.join(dir, "photo (1).png"), "utf8")).toBe("de");
    expect(fs.readFileSync(path.join(dir, "PHOTO (2).PNG"), "utf8")).toBe("f");
    expect(fs.readdirSync(dir).filter((f) => f !== "meta.json").sort())
      .toEqual(["PHOTO (2).PNG", "Photo.png", "photo (1).png"]);

    // The same spelling again replaces its own file in place.
    install(dataDir, POST, "Photo.png", Buffer.from("xyz"), meta("Photo.png"));
    expect(fs.readFileSync(path.join(dir, "Photo.png"), "utf8")).toBe("xyz");
    expect(listAssets(dataDir, POST).assets).toHaveLength(3);
  });
});

// --- Crash recovery: a derived cache reconciled against the files -----------

describe("listAssets self-heals against the files on disk", () => {
  it("recovers an asset file whose meta.json is missing (interrupted first upload)", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    // Simulate a crash after the file was installed but before meta was written.
    fs.unlinkSync(path.join(assetDir(dataDir, POST), "meta.json"));

    // Old behaviour threw here; now the file is projected back into the list.
    const listed = listAssets(dataDir, POST).assets;
    expect(listed.map((a) => a.filename)).toEqual(["a.png"]);
    expect(listed[0].size).toBe(3); // size recovered from the file itself
  });

  it("drops a cached entry whose file is gone (interrupted delete)", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    install(dataDir, POST, "b.png", Buffer.from("de"), meta("b.png", 2));
    // Simulate a crash after the file was unlinked but before meta was rewritten.
    fs.unlinkSync(path.join(assetDir(dataDir, POST), "a.png"));

    const listed = listAssets(dataDir, POST).assets;
    expect(listed.map((a) => a.filename)).toEqual(["b.png"]);
  });

  it("ignores dotfiles (in-flight temp files) when reconciling", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    fs.writeFileSync(path.join(assetDir(dataDir, POST), ".upload-tmp-123"), "partial");

    expect(listAssets(dataDir, POST).assets.map((a) => a.filename)).toEqual(["a.png"]);
  });

  it("ignores a crash-orphaned <stem>-<nanoid>.tmp (current atomic-write shape, no leading dot)", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    fs.writeFileSync(path.join(assetDir(dataDir, POST), "photo-V1StGXR8_Z5jD.tmp"), "partial");

    expect(listAssets(dataDir, POST).assets.map((a) => a.filename)).toEqual(["a.png"]);
  });

  // content-lifecycle-conventions: a missing time is not made up. A file's
  // modified time is when it was last written — a copy or a git checkout resets
  // it — so it is not an upload time, shown or stored.
  it("gives a file it has no record of no upload time, and never stores one", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    const dir = assetDir(dataDir, POST);
    fs.unlinkSync(path.join(dir, "meta.json"));

    expect(listAssets(dataDir, POST).assets[0]).toEqual({ filename: "a.png", size: 3, contentHash: sha("abc") });

    // The next upload and the next delete write the list back to meta.json,
    // with an image's hash, so it is not read again to list it.
    install(dataDir, POST, "b.png", Buffer.from("de"), meta("b.png", 2));
    const afterUpload = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8")).assets as AssetMeta[];
    expect(afterUpload.find((a) => a.filename === "a.png")).toEqual({ filename: "a.png", size: 3, contentHash: sha("abc"), mtimeMs: expect.any(Number) });
    expect(afterUpload.find((a) => a.filename === "b.png")?.uploadedAt).toBe("2026-01-01T00:00:00.000Z");

    fs.writeFileSync(path.join(dir, "c.png"), "xyz");
    deleteAsset(dataDir, POST, "b.png");
    const afterDelete = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8")).assets as AssetMeta[];
    expect(afterDelete).toEqual([
      { filename: "a.png", size: 3, contentHash: sha("abc"), mtimeMs: expect.any(Number) },
      { filename: "c.png", size: 3, contentHash: sha("xyz"), mtimeMs: expect.any(Number) },
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
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    fs.writeFileSync(path.join(dir(), "meta.json"), body);

    const listing = listAssets(dataDir, POST);

    expect(listing.assets).toEqual([{ filename: "a.png", size: 3, contentHash: sha("abc") }]);
    expect(invalidFiles()).toHaveLength(1);
    const [moved] = invalidFiles();
    expect(moved).toMatch(/^meta-\d{8}-\d{6}-utc\.invalid$/);
    expect(fs.readFileSync(path.join(dir(), moved), "utf8")).toBe(body);
    expect(listing.movedAside).toEqual({ path: path.join(dir(), "meta.json"), movedTo: path.join(dir(), moved) });
    // Absent now, so nothing is written until the next upload or delete.
    expect(fs.existsSync(path.join(dir(), "meta.json"))).toBe(false);
    expect(listAssets(dataDir, POST).movedAside).toBeUndefined();
  });

  it("writes nothing when the move fails, leaving meta.json and the files as they were", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    const metaPath = path.join(dir(), "meta.json");
    fs.writeFileSync(metaPath, "{ not json");
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    try {
      expect(() => install(dataDir, POST, "b.png", Buffer.from("de"), meta("b.png", 2))).toThrow(QuarantineError);
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
  it("does not certify hashless disposable prior-format upload facts as current", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    const file = path.join(assetDir(dataDir, POST), "meta.json");
    const prior = JSON.stringify({ formatVersion: 1, assets: [{ ...meta("a.png"), width: 7, height: 8, hasMetadata: true }] });
    fs.writeFileSync(file, prior);
    expect(listAssets(dataDir, POST).assets).toEqual([{ filename: "a.png", size: 3, contentHash: sha("abc") }]);
    expect(fs.readFileSync(file, "utf-8")).toBe(prior);
  });

  const metaFile = () => path.join(assetDir(dataDir, POST), "meta.json");

  it("writes this build's format version and reads the list back", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    expect(JSON.parse(fs.readFileSync(metaFile(), "utf-8"))).toEqual({
      formatVersion: 2,
      assets: [{ ...meta("a.png"), contentHash: createHash("sha256").update("abc").digest("hex"), mtimeMs: fs.statSync(path.join(assetDir(dataDir, POST), "a.png")).mtimeMs }],
    });
    expect(listAssets(dataDir, POST).assets).toEqual([{ ...meta("a.png"), contentHash: sha("abc") }]);
  });

  it("reads a meta.json without its format version as this build's format", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    const { assets } = JSON.parse(fs.readFileSync(metaFile(), "utf-8"));
    fs.writeFileSync(metaFile(), JSON.stringify({ assets: [{ ...assets[0], width: 7 }] }));
    expect(listAssets(dataDir, POST).assets).toEqual([{ ...meta("a.png"), width: 7, contentHash: sha("abc") }]);
  });

  it("lists from the files over a meta.json it could not read, refuses writes, and never moves it", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    // A directory where the file should be fails the read itself, as a permission error does.
    fs.rmSync(metaFile());
    fs.mkdirSync(metaFile());

    expect(listAssets(dataDir, POST)).toEqual({ assets: [{ filename: "a.png", size: 3, contentHash: sha("abc") }] });
    expect(() => install(dataDir, POST, "b.png", Buffer.from("de"), meta("b.png", 2))).toThrow(UnreadableStoreError);
    expect(() => deleteAsset(dataDir, POST, "a.png")).toThrow(UnreadableStoreError);
    expect(fs.statSync(metaFile()).isDirectory()).toBe(true);
    expect(fs.readdirSync(assetDir(dataDir, POST)).sort()).toEqual(["a.png", "meta.json"]);
  });

  it("lists from the files over a meta.json a newer version wrote, refuses writes, and leaves it byte-identical", () => {
    install(dataDir, POST, "a.png", Buffer.from("abc"), meta("a.png"));
    const body = JSON.stringify({ formatVersion: 999, items: [] });
    fs.writeFileSync(metaFile(), body);

    expect(listAssets(dataDir, POST).assets).toEqual([{ filename: "a.png", size: 3, contentHash: sha("abc") }]);
    expect(() => install(dataDir, POST, "b.png", Buffer.from("de"), meta("b.png", 2))).toThrow(NewerFormatError);
    expect(() => deleteAsset(dataDir, POST, "a.png")).toThrow(NewerFormatError);

    expect(fs.readFileSync(metaFile(), "utf-8")).toBe(body);
    expect(fs.readdirSync(assetDir(dataDir, POST)).sort()).toEqual(["a.png", "meta.json"]);
  });
});
