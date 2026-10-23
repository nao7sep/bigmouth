// Integration test for the per-post asset IPC handlers (list / upload / delete):
// the real assetStore + postStore + configStore run against a throwaway
// BIGMOUTH_DATA_DIR + a real registered workspace. The async storageAccess mock
// calls real services and task guards; Electron and the logger are mocked.
// An upload is driven as the preload drives it: a start message and a port, on
// which the file's bytes follow in slices main asks for (see tests/main/uploadStream.ts).
//
// A fresh workspace has no targets, so a target is registered through the real
// configStore before any post is created (createPost would otherwise reject).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MessageChannel } from "node:worker_threads";
import { createHash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  ASSET_UPLOAD_SLICE_BYTES,
  ASSET_UPLOAD_IDLE_MS,
  CHANNELS,
  type AssetDeleteResult,
  type AssetUploadFromMain,
  type AssetUploadResult,
} from "@shared/ipc";
import { mainEnd, playRenderer, slicesOf, type SliceStep } from "../uploadStream.js";
import type { AssetListing, AssetMeta, Post, Target } from "@shared/types";

const transport = vi.hoisted(() => ({
  afterPublication: null as null | (() => Promise<void>),
  beforeWorkspaceResolution: null as null | ((id: string) => Promise<void>),
}));

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

// The derivative cache the handlers register images with; none unless a test sets one.
const derivatives = vi.hoisted(() => ({
  current: null as null | { register: ReturnType<typeof vi.fn>; prepare: ReturnType<typeof vi.fn> },
}));
vi.mock("@main/imageDerivatives.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@main/imageDerivatives.js")>()),
  imageDerivatives: () => derivatives.current,
}));

vi.mock("@main/storageAccess.js", async () => {
  const workspace = await import("@main/core/services/workspaceStore.js");
  const config = await import("@main/core/services/configStore.js");
  const post = await import("@main/core/services/postStore.js");
  const { storageTasks } = await import("@main/storageTasks.js");
  const asset = await import("@main/core/services/assetStore.js");
  return {
    getWorkspace: async (...args: Parameters<typeof workspace.getWorkspace>) => {
      await transport.beforeWorkspaceResolution?.(args[0]);
      return workspace.getWorkspace(...args);
    },
    getSettings: async (...args: Parameters<typeof config.getSettings>) => config.getSettings(...args),
    getTargets: async (...args: Parameters<typeof config.getTargets>) => config.getTargets(...args),
    setContentSaveListener: post.setContentSaveListener,
    setHeldEditFailureListener: () => {},
    refreshIndex: async (...args: Parameters<typeof post.refreshIndex>) => post.refreshIndex(...args),
    listByStatus: async (...args: Parameters<typeof post.listByStatus>) => post.listByStatus(...args),
    countByStatus: async (...args: Parameters<typeof post.countByStatus>) => post.countByStatus(...args),
    getPost: async (...args: Parameters<typeof post.getPost>) => post.getPost(...args),
    changeStatus: async (...args: Parameters<typeof storageTasks.changeStatus>) => storageTasks.changeStatus(...args),
    setLocked: async (...args: Parameters<typeof storageTasks.setLocked>) => storageTasks.setLocked(...args),
    deletePost: async (...args: Parameters<typeof post.deletePost>) => post.deletePost(...args),
    rebuildIndex: async (...args: Parameters<typeof post.rebuildIndex>) => post.rebuildIndex(...args),
    postExists: async (...args: Parameters<typeof post.postExists>) => post.postExists(...args),
    listReferrers: async (...args: Parameters<typeof post.listReferrers>) => post.listReferrers(...args),
    queueContent: async (...args: Parameters<typeof post.queueContent>) => post.queueContent(...args),
    queueMetadata: async (...args: Parameters<typeof post.queueMetadata>) => post.queueMetadata(...args),
    recordAssetChange: async (...args: Parameters<typeof post.recordAssetChange>) => post.recordAssetChange(...args),
    createPost: async (...args: Parameters<typeof storageTasks.createPost>) => storageTasks.createPost(...args),
    updatePost: async (...args: Parameters<typeof storageTasks.updatePost>) => storageTasks.updatePost(...args),
    installAsset: async (...args: Parameters<typeof storageTasks.installAsset>) => {
      const result = storageTasks.installAsset(...args);
      await transport.afterPublication?.();
      return result;
    },
    deleteAsset: async (...args: Parameters<typeof storageTasks.deleteAsset>) => {
      const result = storageTasks.deleteAsset(...args);
      await transport.afterPublication?.();
      return result;
    },
    readSourceMetadata: async (...args: Parameters<typeof storageTasks.readSourceMetadata>) => storageTasks.readSourceMetadata(...args),
    fileExists: async (...args: Parameters<typeof storageTasks.fileExists>) => storageTasks.fileExists(...args),
    listAssets: async (...args: Parameters<typeof asset.listAssets>) => asset.listAssets(...args),
  };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
    on: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
  },
}));

vi.mock("@main/core/services/logger.js", () => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));

import { initAppDir, createWorkspace } from "@main/core/services/workspaceStore.js";
import { saveTargets } from "@main/core/services/configStore.js";
import { changeStatus, clearCache, deletePost, getPost, setLocked } from "@main/core/services/postStore.js";
import { assetDir, stagingDir } from "@main/core/services/assetStore.js";
import { handleUpload, registerAssetHandlers } from "@main/ipc/assets.js";
import { registerPostHandlers } from "@main/ipc/posts.js";
import { StagingFile } from "@main/assetUpload.js";
import * as storageAccess from "@main/storageAccess.js";

let home: string;
let wsId: string;
let dataDir: string;
const SAVED_HOME = process.env.BIGMOUTH_DATA_DIR;

const TARGET: Target = { name: "blogger", defaultLanguage: "en", requiresMetadata: false };

// A real 1x1 PNG. exifr finds no metadata in it, so hasMetadata stays unset.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAACAAEABQABCi0q8AAAAASUVORK5CYI",
  "base64",
);

// The smallest JPEG exifr reads metadata from: an APP1 Exif segment whose one
// IFD0 entry names the camera's make ("abc").
const JPEG_WITH_EXIF = Buffer.from([
  0xff, 0xd8, // SOI
  0xff, 0xe1, 0x00, 0x22, // APP1, 34 bytes
  0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
  0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // little-endian TIFF, IFD0 at 8
  0x01, 0x00, // one entry
  0x0f, 0x01, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, 0x61, 0x62, 0x63, 0x00, // Make, ASCII, 4: "abc"
  0x00, 0x00, 0x00, 0x00, // no next IFD
  0xff, 0xd9, // EOI
]);

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return handlers.get(channel)!({}, ...args) as Promise<T>;
}

async function invokeAsync<T>(channel: string, ...args: unknown[]): Promise<T> {
  return (await handlers.get(channel)!({}, ...args)) as Promise<T> as T;
}

/** A file as the renderer offers it: its name, its bytes, and where it is on disk. */
interface Offered {
  name: string;
  bytes: Buffer;
  sourcePath?: unknown;
}

function upload(name: string, bytes: Buffer): Offered {
  return { name, bytes };
}

/**
 * Uploads `file` the way the preload does, answering main's requests with
 * `steps` (its slices by default), and returns main's final message, or null
 * when main answered nothing.
 */
async function send(postId: string, file: Offered, steps?: (index: number) => SliceStep, start?: unknown): Promise<AssetUploadFromMain | null> {
  const { port1, port2 } = new MessageChannel();
  const renderer = playRenderer(port1, steps ?? slicesOf(file.bytes, ASSET_UPLOAD_SLICE_BYTES));
  const offered = { wsId, postId, name: file.name, ...(file.sourcePath !== undefined && { sourcePath: file.sourcePath }) };
  await handleUpload(mainEnd(port2), start === undefined ? offered : start);
  return renderer;
}

/** The upload's result; an upload that failed outright fails the test. */
async function uploadResult(postId: string, file: Offered): Promise<AssetUploadResult> {
  const reply = await send(postId, file);
  if (reply?.type !== "result") throw new Error(`Upload failed: ${JSON.stringify(reply)}`);
  return reply.result;
}

async function invokeUpload(postId: string, file: Offered): Promise<AssetMeta> {
  const result = await uploadResult(postId, file);
  if (!result.ok) throw new Error(`Unexpected upload refusal: ${JSON.stringify(result)}`);
  return result.asset;
}

const staged = () => (fs.existsSync(stagingDir(dataDir)) ? fs.readdirSync(stagingDir(dataDir)) : []);

/** Creates a draft post through the post handler and returns its id. */
async function createDraft(): Promise<string> {
  const post = (await invoke<Post>(CHANNELS.createPost, wsId, "blogger", "en"));
  return post.frontMatter.id;
}

beforeEach(() => {
  transport.afterPublication = null;
  transport.beforeWorkspaceResolution = null;
  derivatives.current = null;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ipc-assets-"));
  process.env.BIGMOUTH_DATA_DIR = home;
  initAppDir();
  handlers.clear();
  registerAssetHandlers();
  registerPostHandlers();
  const ws = createWorkspace("WS");
  wsId = ws.id;
  dataDir = ws.dataDirectory;
  saveTargets(dataDir, [TARGET]);
});

afterEach(() => {
  clearCache(dataDir);
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("asset IPC handlers — workspace resolution", () => {
  it("rejects an unknown workspace id", async () => {
    await expect(invoke(CHANNELS.listAssets, "nope", "post-1")).rejects.toThrow(/workspace not found/i);
  });
});

describe("listAssets", () => {
  it("returns an empty list for a post with no assets", async () => {
    const id = (await createDraft());
    expect((await invoke<AssetListing>(CHANNELS.listAssets, wsId, id)).assets).toEqual([]);
  });

  it("rejects an invalid postId (path-traversal defense)", async () => {
    await expect(invoke(CHANNELS.listAssets, wsId, "../escape")).rejects.toThrow(/Invalid postId/);
  });
});

describe("image derivatives", () => {
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

  beforeEach(() => {
    derivatives.current = { register: vi.fn(), prepare: vi.fn() };
  });

  it("registers each listed image by its hash, and no other file", async () => {
    const id = await createDraft();
    await invokeUpload(id, upload("pic.png", PNG_1x1));
    await invokeUpload(id, upload("notes.txt", Buffer.from("text")));
    derivatives.current!.register.mockClear();

    const { assets } = await invoke<AssetListing>(CHANNELS.listAssets, wsId, id);
    expect(assets.find((a) => a.filename === "pic.png")?.contentHash).toBe(sha(PNG_1x1));
    expect(derivatives.current!.register.mock.calls).toEqual([
      [sha(PNG_1x1), wsId, path.join(assetDir(dataDir, id), "pic.png"), dataDir],
    ]);
  });

  it.skipIf(process.platform === "win32")("registers contained linked images and omits escaping links", async () => {
    const id = await createDraft();
    const dir = assetDir(dataDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const shared = path.join(dataDir, "shared.png");
    const outside = path.join(path.dirname(dataDir), "outside-linked.png");
    fs.writeFileSync(shared, PNG_1x1);
    fs.writeFileSync(outside, PNG_1x1);
    try {
      fs.symlinkSync(shared, path.join(dir, "contained.png"));
      fs.symlinkSync(outside, path.join(dir, "outside.png"));
      const listing = await invoke<AssetListing>(CHANNELS.listAssets, wsId, id);
      expect(listing.assets.map((asset) => asset.filename)).toEqual(["contained.png"]);
      expect(derivatives.current!.register).toHaveBeenCalledWith(sha(PNG_1x1), wsId, path.join(dir, "contained.png"), dataDir);
      expect(fs.readFileSync(outside)).toEqual(PNG_1x1);
    } finally { fs.rmSync(outside, { force: true }); }
  });

  it("starts making a still image's derivatives once it is added", async () => {
    const id = await createDraft();
    const added = await invokeUpload(id, upload("pic.png", PNG_1x1));
    expect(added.contentHash).toBe(sha(PNG_1x1));
    expect(derivatives.current!.register).toHaveBeenCalledWith(sha(PNG_1x1), wsId, path.join(assetDir(dataDir, id), "pic.png"), dataDir);
    expect(derivatives.current!.prepare).toHaveBeenCalledWith(sha(PNG_1x1));
  });

  it("records an animated image as animated and makes no derivatives of it", async () => {
    const id = await createDraft();
    const sharp = (await import("sharp")).default;
    const pixels = Buffer.alloc(4 * 4 * 2 * 4, 255);
    pixels.fill(0, 0, 4 * 4 * 4);
    const gif = await sharp(pixels, { raw: { width: 4, height: 8, channels: 4, pageHeight: 4 } }).gif().toBuffer();
    const added = await invokeUpload(id, upload("moving.gif", gif));
    expect(added).toMatchObject({ width: 4, height: 4, animated: true });
    expect(derivatives.current!.prepare).not.toHaveBeenCalled();
  });
});

describe("uploadAsset", () => {
  it("answers on the port that arrives with the start message", async () => {
    const id = await createDraft();
    const { port1, port2 } = new MessageChannel();
    const renderer = playRenderer(port1, slicesOf(Buffer.from("hello"), ASSET_UPLOAD_SLICE_BYTES));
    handlers.get(CHANNELS.uploadAsset)!({ ports: [mainEnd(port2)] }, { wsId, postId: id, name: "notes.txt" });
    expect(await renderer).toEqual({ type: "result", result: { ok: true, asset: expect.objectContaining({ filename: "notes.txt", size: 5 }) } });
  });

  it("preserves shared attachments when copied post files duplicate an id", async () => {
    const id = await createDraft();
    await invokeUpload(id, upload("pic.png", PNG_1x1));
    const post = await invoke<Post>(CHANNELS.getPost, wsId, id);
    const filename = fs.readdirSync(path.join(dataDir, "posts")).find((name) => name.endsWith(".md"))!;
    fs.copyFileSync(path.join(dataDir, "posts", filename), path.join(dataDir, "posts", "duplicate.md"));
    // The refusal carries its catalogue message to the renderer, not the raw error.
    expect(await send(id, upload("pic.png", Buffer.from("changed")))).toEqual({ type: "failed", message: expect.stringContaining("bigmouth-message:") });
    await expect(invoke(CHANNELS.deleteAsset, wsId, id, "pic.png")).rejects.toThrow("bigmouth-message:");
    expect(fs.readFileSync(path.join(assetDir(dataDir, id), "pic.png"))).toEqual(PNG_1x1);
    expect(post.frontMatter.id).toBe(id);
    expect(staged()).toEqual([]);
  });

  it("stores an image and lists it back", async () => {
    const id = (await createDraft());
    const meta = await invokeUpload(id, upload("pic.png", PNG_1x1));

    expect(meta.filename).toBe("pic.png");
    expect(meta.size).toBe(PNG_1x1.length);
    expect(meta.uploadedAt).toBeTruthy();

    const listed = (await invoke<AssetListing>(CHANNELS.listAssets, wsId, id)).assets;
    expect(listed.map((a) => a.filename)).toEqual(["pic.png"]);
    // The bytes actually landed on disk under assets/{postId}/.
    expect(fs.existsSync(path.join(assetDir(dataDir, id), "pic.png"))).toBe(true);
  });

  it("installs the exact bytes of a file sent in several slices, with their hash, and leaves no stage", async () => {
    const id = await createDraft();
    const bytes = Buffer.alloc(ASSET_UPLOAD_SLICE_BYTES * 2 + 123);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31) & 0xff;
    const meta = await invokeUpload(id, upload("clip.bin", bytes));

    const file = path.join(assetDir(dataDir, id), "clip.bin");
    expect(meta.size).toBe(bytes.length);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    const [record] = JSON.parse(fs.readFileSync(path.join(assetDir(dataDir, id), "meta.json"), "utf8")).assets;
    expect(record.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(staged()).toEqual([]);
  });

  // Dimensions need a decoder; the renderer does not decode uploads, and main
  // takes nothing it sends but the name, the bytes and where the file is.
  it("records the image's own dimensions from its header, whatever the renderer sends with the file", async () => {
    const id = (await createDraft());
    const reply = await send(id, upload("pic.png", PNG_1x1), undefined, { wsId, postId: id, name: "pic.png", width: 640, height: 480 });
    expect(reply).toEqual({ type: "result", result: { ok: true, asset: expect.objectContaining({ width: 1, height: 1, animated: false }) } });
  });

  it("stores a crafted box-format payload that is no readable image without dimensions", async () => {
    const id = (await createDraft());
    // Zero-sized `ftyp` box: the shape behind the removed image-size HEIF/JXL
    // infinite-loop advisories. The misleading .jpg name cannot make main decode it.
    const crafted = Buffer.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    const meta = await invokeUpload(id, upload("renamed.jpg", crafted));

    expect(meta.width).toBeUndefined();
    expect(meta.height).toBeUndefined();
    expect(fs.readFileSync(path.join(assetDir(dataDir, id), "renamed.jpg"))).toEqual(crafted);
  });

  // exifr reads the staged file itself, in chunks, rather than bytes in memory.
  it("flags an image whose staged file carries EXIF metadata", async () => {
    const id = await createDraft();
    const meta = await invokeUpload(id, upload("camera.jpg", JPEG_WITH_EXIF));
    expect(meta.hasMetadata).toBe(true);
    expect((await invokeUpload(id, upload("plain.png", PNG_1x1))).hasMetadata).toBeUndefined();
  });

  it("stores a non-image file without dimensions", async () => {
    const id = (await createDraft());
    const meta = await invokeUpload(id, upload("notes.txt", Buffer.from("hello")));
    expect(meta.filename).toBe("notes.txt");
    expect(meta.size).toBe(5);
    expect(meta.width).toBeUndefined();
    expect(meta.height).toBeUndefined();
  });

  it("stores an empty file", async () => {
    const id = await createDraft();
    expect(await invokeUpload(id, upload("empty.txt", Buffer.alloc(0)))).toMatchObject({ filename: "empty.txt", size: 0 });
  });

  it("sanitizes the filename (strips path components)", async () => {
    const id = (await createDraft());
    const meta = await invokeUpload(id, upload("../../etc/passwd", Buffer.from("x")));
    expect(meta.filename).toBe("passwd");
  });

  it.each([
    ["an invalid postId", { postId: "../escape", name: "a.png" }],
    ["no name", { postId: "VALID", name: "" }],
    ["no start at all", null],
  ])("fails an upload with %s before any bytes are asked for, in fixed words", async (_label, start) => {
    const id = await createDraft();
    const asked = vi.fn((): SliceStep => null);
    const reply = await send(id, upload("a.png", PNG_1x1), asked, start && { wsId, ...start, postId: start.postId === "VALID" ? id : start.postId });
    expect(reply).toEqual({ type: "failed", message: "The file could not be added." });
    expect(asked).not.toHaveBeenCalled();
  });

  it("refuses an upload to a post that does not exist before any bytes are asked for", async () => {
    const asked = vi.fn((): SliceStep => null);
    expect(await send("missingid", upload("a.png", PNG_1x1), asked)).toEqual({ type: "result", result: { ok: false, admission: { code: "post-missing" } } });
    expect(asked).not.toHaveBeenCalled();
  });

  it("refuses an upload when the post is locked while its bytes stream in, and removes the stage", async () => {
    const id = (await createDraft());
    const reply = await send(id, upload("late.png", PNG_1x1), (index) => {
      if (index === 0) setLocked(dataDir, id, true);
      return slicesOf(PNG_1x1, ASSET_UPLOAD_SLICE_BYTES)(index);
    });

    expect(reply).toEqual({ type: "result", result: { ok: false, admission: { code: "post-locked" } } });
    expect((await invoke<AssetListing>(CHANNELS.listAssets, wsId, id)).assets).toEqual([]);
    expect(staged()).toEqual([]);
  });

  it("refuses an upload when the post is deleted while its bytes stream in, and removes the stage", async () => {
    const id = (await createDraft());
    const reply = await send(id, upload("late.png", PNG_1x1), (index) => {
      if (index === 0) deletePost(dataDir, id);
      return slicesOf(PNG_1x1, ASSET_UPLOAD_SLICE_BYTES)(index);
    });

    expect(reply).toEqual({ type: "result", result: { ok: false, admission: { code: "post-missing" } } });
    expect(staged()).toEqual([]);
  });

  it("says the file could not be read when the renderer stops reading it, and removes the stage", async () => {
    const id = await createDraft();
    const reply = await send(id, upload("moved.png", PNG_1x1), (index) => (index === 0 ? Buffer.from("first part") : "abort"));
    expect(reply).toEqual({ type: "result", result: { ok: false, failure: { code: "source-unreadable" } } });
    expect((await invoke<AssetListing>(CHANNELS.listAssets, wsId, id)).assets).toEqual([]);
    expect(staged()).toEqual([]);
  });

  it("answers nothing and removes the stage when the renderer goes away mid-file", async () => {
    const id = await createDraft();
    const discarded = barrier();
    const realDiscard = StagingFile.prototype.discard;
    const discard = vi.spyOn(StagingFile.prototype, "discard").mockImplementation(async function (this: StagingFile) {
      await realDiscard.call(this);
      discarded.release();
    });
    try {
      const reply = await send(id, upload("gone.png", PNG_1x1), (index) => (index === 0 ? Buffer.from("first part") : "close"));
      expect(reply).toBeNull();
      // The closed caller has already returned; cleanup still owns started I/O.
      await discarded.promise;
      await nextTurn();
      expect(staged()).toEqual([]);
    } finally { discard.mockRestore(); }
  });

  it("says the workspace folder is full when a staged write meets ENOSPC, and removes the stage", async () => {
    const id = await createDraft();
    const open = fsp.open;
    const spy = vi.spyOn(fsp, "open").mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await open(...args);
      (handle as unknown as { write: () => Promise<never> }).write = () =>
        Promise.reject(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }));
      return handle;
    });
    let reply: AssetUploadFromMain | null;
    try {
      reply = await send(id, upload("big.mov", Buffer.alloc(1024)));
    } finally { spy.mockRestore(); }
    expect(reply).toEqual({ type: "result", result: { ok: false, failure: { code: "workspace-unwritable", problem: "full" } } });
    expect(staged()).toEqual([]);
  });

  it("says the workspace folder refused the file when installing it fails, and removes the stage", async () => {
    const id = await createDraft();
    const realRename = fs.renameSync.bind(fs);
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).endsWith(".part")) throw Object.assign(new Error("EACCES: permission denied, rename"), { code: "EACCES" });
      return realRename(from, to);
    });
    let result: AssetUploadResult;
    try {
      result = await uploadResult(id, upload("a.png", PNG_1x1));
    } finally { spy.mockRestore(); }
    expect(result).toEqual({ ok: false, failure: { code: "workspace-unwritable", problem: "denied" } });
    expect(fs.existsSync(path.join(assetDir(dataDir, id), "a.png"))).toBe(false);
    expect(staged()).toEqual([]);
  });

  // The reader has always filtered these names out of every listing, so storing
  // one meant bytes that were written, reported as saved, and then unreachable -
  // and "meta.json" was worse: the sidecar write on the next line landed on the
  // same path, destroying the user's file and the whole asset list with it.
  it.each(["meta.json", "notes.tmp", ".env"])(
    "refuses to store %s rather than losing it",
    async (name) => {
      const id = (await createDraft());
      await uploadResult(id, upload("keep.png", PNG_1x1));

      await expect(
        uploadResult(id, upload(name, Buffer.from("USER-PAYLOAD"))),
      ).resolves.toEqual({ ok: false, admission: { code: "reserved-name", filename: name } });

      // The asset that was already there is untouched.
      expect((await invoke<AssetListing>(CHANNELS.listAssets, wsId, id)).assets.map((a) => a.filename)).toEqual([
        "keep.png",
      ]);
    },
  );

  it("keeps two non-ASCII names apart instead of collapsing them onto one file", async () => {
    // Sanitized to "_.png", both names would read to the collision check as a
    // re-upload of the same asset, so the second would silently replace the
    // first. This app ships `ja` as a first-class post language.
    const id = (await createDraft());
    await uploadResult(id, upload("桜.png", PNG_1x1));
    await uploadResult(id, upload("梅.png", PNG_1x1));

    expect((await invoke<AssetListing>(CHANNELS.listAssets, wsId, id)).assets.map((a) => a.filename).sort()).toEqual(
      ["梅.png", "桜.png"].sort(),
    );
  });

  it("refuses to upload to a locked post", async () => {
    const id = (await createDraft());
    setLocked(dataDir, id, true);
    await expect(uploadResult(id, upload("a.png", PNG_1x1))).resolves.toEqual(
      { ok: false, admission: { code: "post-locked" } },
    );
  });

  it("uploads to a published post that is not locked", async () => {
    const id = (await createDraft());
    changeStatus(dataDir, id, "published");
    const result = await uploadResult(id, upload("a.png", PNG_1x1));
    expect(result.ok).toBe(true);
  });

  // An attached file is the post's content (content-lifecycle-conventions), so
  // uploading or replacing one is an edit of the post.
  it("moves the post's modified time to the moment of the upload", async () => {
    const id = (await createDraft());
    const before = getPost(dataDir, id)!.frontMatter.updatedAtUtc;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
      await uploadResult(id, upload("a.png", PNG_1x1));
      expect(getPost(dataDir, id)!.frontMatter.updatedAtUtc).toBe("2030-01-01T00:00:00.000Z");

      vi.setSystemTime(new Date("2030-01-02T00:00:00.000Z"));
      await uploadResult(id, upload("a.png", Buffer.concat([PNG_1x1, Buffer.from([0])])));
      expect(getPost(dataDir, id)!.frontMatter.updatedAtUtc).toBe("2030-01-02T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
    expect(before).not.toBe("2030-01-01T00:00:00.000Z");
  });

  // A copy keeps the source's metadata (content-lifecycle-conventions).
  it("keeps the picked file's modified time and permissions on the copy", async () => {
    const id = (await createDraft());
    const sourcePath = path.join(home, "picked.png");
    fs.writeFileSync(sourcePath, PNG_1x1);
    // Windows has no POSIX permission bits, so only the modified time is checked there.
    if (process.platform !== "win32") fs.chmodSync(sourcePath, 0o640);
    const then = new Date("2021-03-04T05:06:07.000Z");
    fs.utimesSync(sourcePath, then, then);

    await invokeUpload(id, { ...upload("pic.png", PNG_1x1), sourcePath });

    const stat = fs.statSync(path.join(dataDir, "assets", id, "pic.png"));
    expect(stat.mtime.toISOString()).toBe(then.toISOString());
    if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o640);
  });

  it("takes nothing from a source path that is not the uploaded file", async () => {
    const id = (await createDraft());
    const other = path.join(home, "other.png");
    fs.writeFileSync(other, Buffer.from("a different size"));
    const then = new Date("2021-03-04T05:06:07.000Z");
    fs.utimesSync(other, then, then);

    for (const [index, sourcePath] of [other, "relative.png", 42].entries()) {
      const bytes = Buffer.concat([PNG_1x1, Buffer.from([index])]);
      await invokeUpload(id, { ...upload("pic.png", bytes), sourcePath });
      const stat = fs.statSync(path.join(dataDir, "assets", id, "pic.png"));
      expect(stat.mtime.toISOString()).not.toBe(then.toISOString());
    }
  });

  // A write that changes nothing is skipped (content-lifecycle-conventions).
  it("changes nothing when the same file is uploaded again under its name", async () => {
    const id = (await createDraft());
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
      await uploadResult(id, upload("a.png", PNG_1x1));
      await uploadResult(id, upload("b.txt", Buffer.from("notes")));
      const metaFile = path.join(dataDir, "assets", id, "meta.json");
      const metaBefore = fs.readFileSync(metaFile, "utf8");

      vi.setSystemTime(new Date("2030-01-02T00:00:00.000Z"));
      const result = await uploadResult(id, upload("a.png", PNG_1x1));

      expect(result).toEqual({ ok: true, asset: expect.objectContaining({ filename: "a.png", uploadedAt: "2030-01-01T00:00:00.000Z" }) });
      expect(getPost(dataDir, id)!.frontMatter.updatedAtUtc).toBe("2030-01-01T00:00:00.000Z");
      expect(fs.readFileSync(metaFile, "utf8")).toBe(metaBefore);
      expect((await invoke<AssetListing>(CHANNELS.listAssets, wsId, id)).assets.map((a) => a.filename)).toEqual(["a.png", "b.txt"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the modified time alone when the upload is refused", async () => {
    const id = (await createDraft());
    setLocked(dataDir, id, true);
    const before = getPost(dataDir, id)!.frontMatter.updatedAtUtc;
    await uploadResult(id, upload("a.png", PNG_1x1));
    expect(getPost(dataDir, id)!.frontMatter.updatedAtUtc).toBe(before);
  });
});

// An asset change that reached the file stands; what failed after it is said,
// not reported as a failure of the change (error-handling-conventions).
describe("an asset change whose record could not be saved", () => {
  /** Fails every rename onto a path ending in `suffix`, as a full or read-only volume would. */
  function failRenamesOnto(suffix: string) {
    const realRename = fs.renameSync.bind(fs);
    return vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith(suffix)) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      return realRename(from, to);
    });
  }

  /** Moves the clock a second ahead until vi.useRealTimers(). Timers stay real. */
  function laterClock() {
    const next = Date.now() + 1000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(next);
  }

  it.each(["upload", "delete"])("owns the post timestamp before a delayed %s reply reaches IPC", async (operation) => {
    const id = await createDraft();
    if (operation === "delete") await uploadResult(id, upload("a.png", PNG_1x1));
    const before = getPost(dataDir, id)!.frontMatter.updatedAtUtc;
    laterClock();
    let release!: () => void;
    let published!: () => void;
    const publication = new Promise<void>((resolve) => { published = resolve; });
    const heldReply = new Promise<void>((resolve) => { release = resolve; });
    transport.afterPublication = () => { published(); return heldReply; };
    const pending = operation === "upload"
      ? uploadResult(id, upload("a.png", PNG_1x1))
      : invokeAsync(CHANNELS.deleteAsset, wsId, id, "a.png");
    try {
      await publication;
      const publishedTime = getPost(dataDir, id)!.frontMatter.updatedAtUtc;
      expect(publishedTime).not.toBe(before);
      // A caller waiting longer cannot move the timestamp a second time.
      vi.setSystemTime(Date.now() + 1000);
      release();
      await pending;
      expect(getPost(dataDir, id)!.frontMatter.updatedAtUtc).toBe(publishedTime);
    } finally {
      release();
      await pending;
      transport.afterPublication = null;
      vi.useRealTimers();
    }
  });

  it("keeps an added file and says its details were not saved", async () => {
    const id = (await createDraft());
    await uploadResult(id, upload("first.png", PNG_1x1));
    const spy = failRenamesOnto("meta.json");
    let result: AssetUploadResult;
    try {
      result = await uploadResult(id, upload("a.png", PNG_1x1));
    } finally {
      spy.mockRestore();
    }
    expect(result).toEqual({ ok: true, asset: expect.objectContaining({ filename: "a.png" }), unsaved: ["details"] });
    expect((await invoke<AssetListing>(CHANNELS.listAssets, wsId, id)).assets.map((a) => a.filename)).toEqual(["first.png", "a.png"]);
  });

  it("keeps an added file and says the post's modified time was not updated", async () => {
    const id = (await createDraft());
    const before = getPost(dataDir, id)!.frontMatter.updatedAtUtc;
    // A later instant, so the modified-time write is a real change that the failing rename meets.
    laterClock();
    const spy = failRenamesOnto(".md");
    let result: AssetUploadResult;
    try {
      result = await uploadResult(id, upload("a.png", PNG_1x1));
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
    expect(result).toEqual({ ok: true, asset: expect.objectContaining({ filename: "a.png" }), unsaved: ["modifiedTime"] });
    expect(fs.existsSync(path.join(dataDir, "assets", id, "a.png"))).toBe(true);
    expect(getPost(dataDir, id)!.frontMatter.updatedAtUtc).toBe(before);
  });

  it("keeps a deleted file deleted and says the post's modified time was not updated", async () => {
    const id = (await createDraft());
    await uploadResult(id, upload("a.png", PNG_1x1));
    await uploadResult(id, upload("b.txt", Buffer.from("notes")));
    // A later instant, so the modified-time write is a real change that the failing rename meets.
    laterClock();
    const spy = failRenamesOnto(".md");
    let result: AssetDeleteResult;
    try {
      result = (await invoke<AssetDeleteResult>(CHANNELS.deleteAsset, wsId, id, "a.png"));
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
    expect(result).toEqual({ unsaved: ["modifiedTime"] });
    expect(fs.existsSync(path.join(dataDir, "assets", id, "a.png"))).toBe(false);
  });

  it("keeps a deleted file deleted when meta.json cannot be rewritten, and lists it gone", async () => {
    const id = (await createDraft());
    await uploadResult(id, upload("a.png", PNG_1x1));
    await uploadResult(id, upload("b.txt", Buffer.from("notes")));
    const spy = failRenamesOnto("meta.json");
    let result: AssetDeleteResult;
    try {
      result = (await invoke<AssetDeleteResult>(CHANNELS.deleteAsset, wsId, id, "a.png"));
    } finally {
      spy.mockRestore();
    }
    expect(result).toEqual({});
    expect((await invoke<AssetListing>(CHANNELS.listAssets, wsId, id)).assets.map((a) => a.filename)).toEqual(["b.txt"]);
  });
});

describe("deleteAsset", () => {
  it("removes a previously uploaded asset", async () => {
    const id = (await createDraft());
    await uploadResult(id, upload("a.png", PNG_1x1));
    expect((await invoke<AssetListing>(CHANNELS.listAssets, wsId, id)).assets.map((a) => a.filename)).toEqual(["a.png"]);

    const result = (await invoke<AssetDeleteResult>(CHANNELS.deleteAsset, wsId, id, "a.png"));
    expect(result).toEqual({});
    expect((await invoke<AssetListing>(CHANNELS.listAssets, wsId, id)).assets).toEqual([]);
  });

  it("rejects an invalid postId or filename", async () => {
    const id = (await createDraft());
    await expect(invoke(CHANNELS.deleteAsset, wsId, "../escape", "a.png")).rejects.toThrow(/Invalid postId or filename/);
    await expect(invoke(CHANNELS.deleteAsset, wsId, id, "../../etc/passwd")).rejects.toThrow(/Invalid postId or filename/);
  });

  it("throws 'Asset not found' when the file is absent", async () => {
    const id = (await createDraft());
    await expect(invoke(CHANNELS.deleteAsset, wsId, id, "ghost.png")).rejects.toThrow(/Asset not found/);
  });

  it("throws 'Post not found' when the post is gone but a stray asset file lingers", async () => {
    // Reach the post-existence check after the file-existence check by writing the
    // asset file straight to disk for a post id that was never created.
    const orphanPost = "orphanpost";
    const dir = assetDir(dataDir, orphanPost);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.png"), PNG_1x1);
    await expect(invoke(CHANNELS.deleteAsset, wsId, orphanPost, "a.png")).rejects.toThrow(/Post not found/);
  });

  it("refuses to delete an asset on a locked post, whatever its status", async () => {
    const id = (await createDraft());
    await uploadResult(id, upload("a.png", PNG_1x1));
    setLocked(dataDir, id, true);
    await expect(invoke(CHANNELS.deleteAsset, wsId, id, "a.png")).rejects.toThrow(/This post is locked/);
    expect(fs.existsSync(path.join(assetDir(dataDir, id), "a.png"))).toBe(true);
  });

  it("moves the post's modified time to the moment of the delete", async () => {
    const id = (await createDraft());
    await uploadResult(id, upload("a.png", PNG_1x1));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2030-02-01T00:00:00.000Z"));
      (await invoke(CHANNELS.deleteAsset, wsId, id, "a.png"));
      expect(getPost(dataDir, id)!.frontMatter.updatedAtUtc).toBe("2030-02-01T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});


/** A controllable operation boundary, without delaying unrelated native work. */
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("upload lifetime ownership", () => {
  it("observes a closed port while workspace lookup is held and never creates a late stage", async () => {
    const id = await createDraft();
    const lookup = barrier();
    const entered = barrier();
    transport.beforeWorkspaceResolution = async () => { entered.release(); await lookup.promise; };
    const create = vi.spyOn(StagingFile, "create");
    const { port1, port2 } = new MessageChannel();
    const renderer = playRenderer(port1, () => null);
    const pending = handleUpload(mainEnd(port2), { wsId, postId: id, name: "gone.txt" });
    try {
      await entered.promise;
      port1.close();
      await pending;
      expect(await renderer).toBeNull();
      expect(create).not.toHaveBeenCalled();
      lookup.release();
      await nextTurn();
      expect(create).not.toHaveBeenCalled();
      expect(staged()).toEqual([]);
    } finally {
      lookup.release();
      await pending;
      await nextTurn();
      create.mockRestore();
      transport.beforeWorkspaceResolution = null;
      port1.close(); port2.close();
    }
  });

  it.each(["creation", "write"] as const)("answers a stalled stage %s but retains same-workspace admission through cleanup", async (phase) => {
    const id = await createDraft();
    const other = createWorkspace("Other", path.join(home, "other-workspace"));
    saveTargets(other.dataDirectory, [TARGET]);
    const otherPost = await invoke<Post>(CHANNELS.createPost, other.id, "blogger", "en");
    const held = barrier();
    const entered = barrier();
    const discarded = barrier();
    const realCreate = StagingFile.create;
    const realWrite = StagingFile.prototype.write;
    const realDiscard = StagingFile.prototype.discard;
    let holdOnce = true;
    const create = vi.spyOn(StagingFile, "create").mockImplementation(async (dir) => {
      if (phase === "creation" && dir === stagingDir(dataDir) && holdOnce) {
        holdOnce = false; entered.release(); await held.promise;
      }
      return realCreate.call(StagingFile, dir);
    });
    const write = vi.spyOn(StagingFile.prototype, "write").mockImplementation(async function (this: StagingFile, bytes) {
      if (phase === "write" && this.path.startsWith(stagingDir(dataDir) + path.sep) && holdOnce) {
        holdOnce = false; entered.release(); await held.promise;
      }
      await realWrite.call(this, bytes);
    });
    const discard = vi.spyOn(StagingFile.prototype, "discard").mockImplementation(async function (this: StagingFile) {
      await realDiscard.call(this);
      if (this.path.startsWith(stagingDir(dataDir) + path.sep)) discarded.release();
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const pending = send(id, upload("stalled.txt", Buffer.from("draft bytes")));
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(ASSET_UPLOAD_IDLE_MS);
      expect(await pending).toEqual({ type: "result", result: { ok: false, failure: { code: "stalled" } } });
      expect(discard).not.toHaveBeenCalled();
      expect(await send(id, upload("busy.txt", Buffer.from("busy"))))
        .toEqual({ type: "result", result: { ok: false, failure: { code: "busy" } } });
      expect(await send(otherPost.frontMatter.id, upload("other.txt", Buffer.from("other")), undefined,
        { wsId: other.id, postId: otherPost.frontMatter.id, name: "other.txt" }))
        .toMatchObject({ type: "result", result: { ok: true, asset: { filename: "other.txt" } } });
      expect(fs.existsSync(path.join(assetDir(dataDir, id), "stalled.txt"))).toBe(false);
      held.release();
      await discarded.promise;
      await nextTurn();
      expect(staged()).toEqual([]);
      expect(await send(id, upload("retry.txt", Buffer.from("retry"))))
        .toMatchObject({ type: "result", result: { ok: true, asset: { filename: "retry.txt" } } });
    } finally {
      held.release();
      await pending;
      await discarded.promise;
      await nextTurn();
      vi.useRealTimers();
      create.mockRestore(); write.mockRestore(); discard.mockRestore();
      clearCache(other.dataDirectory);
    }
  });

  it("never publishes when the renderer does not acknowledge installation", async () => {
    const id = await createDraft();
    const proposal = barrier();
    const install = vi.spyOn(storageAccess, "installAsset");
    const discarded = barrier();
    const realDiscard = StagingFile.prototype.discard;
    const discard = vi.spyOn(StagingFile.prototype, "discard").mockImplementation(async function (this: StagingFile) {
      await realDiscard.call(this);
      discarded.release();
    });
    const { port1, port2 } = new MessageChannel();
    let ended = false;
    const replies: AssetUploadFromMain[] = [];
    port1.on("message", (reply: AssetUploadFromMain) => {
      replies.push(reply);
      if (reply.type === "next" && !ended) { ended = true; port1.postMessage({ type: "end" }); }
      if (reply.type === "installing") proposal.release();
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const pending = handleUpload(mainEnd(port2), { wsId, postId: id, name: "unacknowledged.txt" });
    try {
      await proposal.promise;
      expect(install).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(ASSET_UPLOAD_IDLE_MS);
      await pending;
      await discarded.promise;
      await nextTurn();
      expect(replies).toContainEqual({ type: "result", result: { ok: false, failure: { code: "stalled" } } });
      expect(install).not.toHaveBeenCalled();
      expect(discard).toHaveBeenCalledTimes(1);
      expect(staged()).toEqual([]);
      expect(fs.existsSync(path.join(assetDir(dataDir, id), "unacknowledged.txt"))).toBe(false);
    } finally {
      await pending;
      await discarded.promise;
      vi.useRealTimers();
      port1.close(); port2.close(); install.mockRestore(); discard.mockRestore();
    }
  });

  it("keeps a started installation pending beyond the upload deadline through its actual reply", async () => {
    const id = await createDraft();
    const publication = barrier();
    const reply = barrier();
    transport.afterPublication = async () => { publication.release(); await reply.promise; };
    const install = vi.spyOn(storageAccess, "installAsset");
    const discard = vi.spyOn(StagingFile.prototype, "discard");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let settled = false;
    const pending = send(id, upload("installed.txt", Buffer.from("one attachment"))).then((result) => { settled = true; return result; });
    try {
      await publication.promise;
      expect(fs.readFileSync(path.join(assetDir(dataDir, id), "installed.txt"), "utf8")).toBe("one attachment");
      await vi.advanceTimersByTimeAsync(ASSET_UPLOAD_IDLE_MS * 2);
      expect(settled).toBe(false);
      expect(discard).not.toHaveBeenCalled();
      expect(await send(id, upload("busy.txt", Buffer.from("busy"))))
        .toEqual({ type: "result", result: { ok: false, failure: { code: "busy" } } });
      reply.release();
      expect(await pending).toMatchObject({ type: "result", result: { ok: true, asset: { filename: "installed.txt" } } });
      expect(install).toHaveBeenCalledTimes(1);
      expect(discard).toHaveBeenCalledTimes(1);
      expect(staged()).toEqual([]);
      expect((await invoke<AssetListing>(CHANNELS.listAssets, wsId, id)).assets.map((asset) => asset.filename)).toEqual(["installed.txt"]);
    } finally {
      reply.release(); await pending;
      transport.afterPublication = null;
      vi.useRealTimers();
      install.mockRestore(); discard.mockRestore();
    }
  });
});
