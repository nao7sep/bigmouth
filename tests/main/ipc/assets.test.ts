// Integration test for the per-post asset IPC handlers (list / upload / delete):
// the real assetStore + postStore + configStore run against a throwaway
// BIGMOUTH_DATA_DIR + a real registered workspace. The async storageAccess mock
// calls real services and task guards; Electron and the logger are mocked.
// The upload handler receives raw bytes plus optional image
// dimensions from the sandboxed renderer, then validates that IPC payload before
// storing it (see src/renderer/src/api.ts `uploadAsset`).
//
// A fresh workspace has no targets, so a target is registered through the real
// configStore before any post is created (createPost would otherwise reject).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNELS, type AssetDeleteResult, type AssetUploadInput, type AssetUploadResult } from "@shared/ipc";
import type { AssetListing, AssetMeta, Post, Target } from "@shared/types";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("@main/storageAccess.js", async () => {
  const workspace = await import("@main/core/services/workspaceStore.js");
  const config = await import("@main/core/services/configStore.js");
  const post = await import("@main/core/services/postStore.js");
  const { storageTasks } = await import("@main/storageTasks.js");
  const asset = await import("@main/core/services/assetStore.js");
  return {
    getWorkspace: async (...args: Parameters<typeof workspace.getWorkspace>) => workspace.getWorkspace(...args),
    getSettings: async (...args: Parameters<typeof config.getSettings>) => config.getSettings(...args),
    getTargets: async (...args: Parameters<typeof config.getTargets>) => config.getTargets(...args),
    setContentSaveListener: post.setContentSaveListener,
    refreshIndex: async (...args: Parameters<typeof post.refreshIndex>) => post.refreshIndex(...args),
    listByStatus: async (...args: Parameters<typeof post.listByStatus>) => post.listByStatus(...args),
    countByStatus: async (...args: Parameters<typeof post.countByStatus>) => post.countByStatus(...args),
    getPost: async (...args: Parameters<typeof post.getPost>) => post.getPost(...args),
    changeStatus: async (...args: Parameters<typeof post.changeStatus>) => post.changeStatus(...args),
    setLocked: async (...args: Parameters<typeof post.setLocked>) => post.setLocked(...args),
    deletePost: async (...args: Parameters<typeof post.deletePost>) => post.deletePost(...args),
    rebuildIndex: async (...args: Parameters<typeof post.rebuildIndex>) => post.rebuildIndex(...args),
    postExists: async (...args: Parameters<typeof post.postExists>) => post.postExists(...args),
    listReferrers: async (...args: Parameters<typeof post.listReferrers>) => post.listReferrers(...args),
    getPostSummary: async (...args: Parameters<typeof post.getPostSummary>) => post.getPostSummary(...args),
    queueContent: async (...args: Parameters<typeof post.queueContent>) => post.queueContent(...args),
    queueMetadata: async (...args: Parameters<typeof post.queueMetadata>) => post.queueMetadata(...args),
    recordAssetChange: async (...args: Parameters<typeof post.recordAssetChange>) => post.recordAssetChange(...args),
    createPost: async (...args: Parameters<typeof storageTasks.createPost>) => storageTasks.createPost(...args),
    updatePost: async (...args: Parameters<typeof storageTasks.updatePost>) => storageTasks.updatePost(...args),
    saveAssetFile: async (...args: Parameters<typeof storageTasks.saveAssetFile>) => storageTasks.saveAssetFile(...args),
    deleteAsset: async (...args: Parameters<typeof storageTasks.deleteAsset>) => storageTasks.deleteAsset(...args),
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
import { saveTargets, saveSettings, getSettings } from "@main/core/services/configStore.js";
import { changeStatus, clearCache, getPost, setLocked } from "@main/core/services/postStore.js";
import { assetDir } from "@main/core/services/assetStore.js";
import { registerAssetHandlers } from "@main/ipc/assets.js";
import { registerPostHandlers } from "@main/ipc/posts.js";

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

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return handlers.get(channel)!({}, ...args) as Promise<T>;
}

async function invokeAsync<T>(channel: string, ...args: unknown[]): Promise<T> {
  return (await handlers.get(channel)!({}, ...args)) as Promise<T> as T;
}

async function invokeUpload(wsId: string, postId: string, file: AssetUploadInput): Promise<AssetMeta> {
  const result = await invokeAsync<AssetUploadResult>(CHANNELS.uploadAsset, wsId, postId, file);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Unexpected upload admission: ${result.admission.code}`);
  return result.asset;
}

/** Builds the byte payload the handler expects from a Buffer. */
function upload(
  name: string,
  bytes: Buffer,
  dimensions: Pick<AssetUploadInput, "width" | "height"> = {},
): AssetUploadInput {
  // Slice to a tight ArrayBuffer so a pooled Node Buffer's backing store is not
  // handed across with extra bytes.
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return { name, data: ab as ArrayBuffer, ...dimensions };
}

/** Creates a draft post through the post handler and returns its id. */
async function createDraft(): Promise<string> {
  const post = (await invoke<Post>(CHANNELS.createPost, wsId, "blogger", "en"));
  return post.frontMatter.id;
}

beforeEach(() => {
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

describe("uploadAsset", () => {
  it("stores a renderer-inspected image with its validated dimensions and lists it back", async () => {
    const id = (await createDraft());
    const meta = await invokeUpload(wsId, id, upload("pic.png", PNG_1x1, { width: 1, height: 1 }));

    expect(meta.filename).toBe("pic.png");
    expect(meta.size).toBe(PNG_1x1.length);
    expect(meta.width).toBe(1);
    expect(meta.height).toBe(1);
    expect(meta.uploadedAt).toBeTruthy();

    const listed = (await invoke<AssetListing>(CHANNELS.listAssets, wsId, id)).assets;
    expect(listed.map((a) => a.filename)).toEqual(["pic.png"]);
    // The bytes actually landed on disk under assets/{postId}/.
    expect(fs.existsSync(path.join(assetDir(dataDir, id), "pic.png"))).toBe(true);
  });

  it.each([
    ["missing height", { width: 640 }],
    ["missing width", { height: 480 }],
    ["zero", { width: 0, height: 480 }],
    ["negative", { width: -1, height: 480 }],
    ["fractional", { width: 1.5, height: 480 }],
    ["infinite", { width: Number.POSITIVE_INFINITY, height: 480 }],
    ["unsafe integer", { width: Number.MAX_SAFE_INTEGER + 1, height: 480 }],
  ])("drops a forged %s dimension payload as an indivisible pair", async (_label, dimensions) => {
    const id = (await createDraft());
    const meta = await invokeUpload(wsId, id, upload("pic.png", PNG_1x1, dimensions));

    expect(meta.width).toBeUndefined();
    expect(meta.height).toBeUndefined();
  });

  it("drops runtime type violations even though the shared TypeScript contract is numeric", async () => {
    const id = (await createDraft());
    const forged = upload("pic.png", PNG_1x1, { width: 640, height: 480 }) as unknown as Record<string, unknown>;
    forged.width = "640";

    const meta = await invokeUpload(wsId, id, forged as unknown as AssetUploadInput);

    expect(meta.width).toBeUndefined();
    expect(meta.height).toBeUndefined();
  });

  it("never annotates a non-image file with forged renderer dimensions", async () => {
    const id = (await createDraft());
    const meta = await invokeUpload(wsId, id, upload("notes.txt", Buffer.from("hello"), { width: 640, height: 480 }));

    expect(meta.width).toBeUndefined();
    expect(meta.height).toBeUndefined();
  });

  it("stores a crafted box-format payload without parsing image dimensions in main", async () => {
    const id = (await createDraft());
    // Zero-sized `ftyp` box: the shape behind the removed image-size HEIF/JXL
    // infinite-loop advisories. The misleading .jpg name cannot make main decode it.
    const crafted = Buffer.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    const meta = await invokeUpload(wsId, id, upload("renamed.jpg", crafted));

    expect(meta.width).toBeUndefined();
    expect(meta.height).toBeUndefined();
    expect(fs.readFileSync(path.join(assetDir(dataDir, id), "renamed.jpg"))).toEqual(crafted);
  });

  it("stores a non-image file without dimensions", async () => {
    const id = (await createDraft());
    const meta = await invokeUpload(wsId, id, upload("notes.txt", Buffer.from("hello")));
    expect(meta.filename).toBe("notes.txt");
    expect(meta.size).toBe(5);
    expect(meta.width).toBeUndefined();
    expect(meta.height).toBeUndefined();
  });

  it("sanitizes the filename (strips path components)", async () => {
    const id = (await createDraft());
    const meta = await invokeUpload(wsId, id, upload("../../etc/passwd", Buffer.from("x")));
    expect(meta.filename).toBe("passwd");
  });

  it("rejects an invalid postId before reaching the store", async () => {
    await expect(invokeAsync(CHANNELS.uploadAsset, wsId, "../escape", upload("a.png", PNG_1x1))).rejects.toThrow(
      /Invalid postId/,
    );
  });

  it("rejects a missing/empty file payload", async () => {
    const id = (await createDraft());
    await expect(invokeAsync(CHANNELS.uploadAsset, wsId, id, undefined as unknown as AssetUploadInput)).rejects.toThrow(
      /No file provided/,
    );
    await expect(
      invokeAsync(CHANNELS.uploadAsset, wsId, id, { name: "a.png" } as unknown as AssetUploadInput),
    ).rejects.toThrow(/No file provided/);
  });

  it("rejects an upload to a post that does not exist", async () => {
    await expect(invokeAsync(CHANNELS.uploadAsset, wsId, "missingid", upload("a.png", PNG_1x1))).rejects.toThrow(
      /Post not found/,
    );
  });

  it("rejects an upload that exceeds the configured size limit", async () => {
    const id = (await createDraft());
    // The smallest valid limit keeps the oversized buffer small.
    const settings = getSettings(dataDir);
    saveSettings(dataDir, { ...settings, maxUploadMb: 1 });
    const oversized = Buffer.concat([PNG_1x1, Buffer.alloc(1024 * 1024)]);
    await expect(invokeAsync<AssetUploadResult>(CHANNELS.uploadAsset, wsId, id, upload("a.png", oversized))).resolves.toEqual(
      { ok: false, admission: { code: "file-too-large", limitMb: 1 } },
    );
  });

  it("refuses an upload when the post is locked while the handler is awaiting metadata", async () => {
    // The lock used to be read at the top of the handler, before the exifr parse.
    // Calling the handler runs it synchronously up to that await and hands control
    // back here, so locking now lands inside the window - and an asset was
    // written into a post the app had already locked.
    const id = (await createDraft());
    const pending = invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("late.png", PNG_1x1));
    setLocked(dataDir, id, true);

    await expect(pending).resolves.toEqual({ ok: false, admission: { code: "post-locked" } });
    expect((await invoke<AssetListing>(CHANNELS.listAssets, wsId, id)).assets).toEqual([]);
  });

  // The reader has always filtered these names out of every listing, so storing
  // one meant bytes that were written, reported as saved, and then unreachable -
  // and "meta.json" was worse: the sidecar write on the next line landed on the
  // same path, destroying the user's file and the whole asset list with it.
  it.each(["meta.json", "notes.tmp", ".env"])(
    "refuses to store %s rather than losing it",
    async (name) => {
      const id = (await createDraft());
      await invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("keep.png", PNG_1x1));

      await expect(
        invokeAsync<AssetUploadResult>(CHANNELS.uploadAsset, wsId, id, upload(name, Buffer.from("USER-PAYLOAD"))),
      ).resolves.toEqual({ ok: false, admission: { code: "reserved-name", filename: name } });

      // The asset that was already there is untouched.
      expect((await invoke<AssetListing>(CHANNELS.listAssets, wsId, id)).assets.map((a) => a.filename)).toEqual([
        "keep.png",
      ]);
    },
  );

  it("keeps two non-ASCII names apart instead of collapsing them onto one file", async () => {
    // Both names used to sanitize to "_.png", which the collision check then read
    // as a re-upload of the same asset - so the second silently replaced the
    // first. This app ships `ja` as a first-class post language.
    const id = (await createDraft());
    await invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("桜.png", PNG_1x1));
    await invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("梅.png", PNG_1x1));

    expect((await invoke<AssetListing>(CHANNELS.listAssets, wsId, id)).assets.map((a) => a.filename).sort()).toEqual(
      ["梅.png", "桜.png"].sort(),
    );
  });

  it("refuses to upload to a locked post", async () => {
    const id = (await createDraft());
    setLocked(dataDir, id, true);
    await expect(invokeAsync<AssetUploadResult>(CHANNELS.uploadAsset, wsId, id, upload("a.png", PNG_1x1))).resolves.toEqual(
      { ok: false, admission: { code: "post-locked" } },
    );
  });

  it("uploads to a published post that is not locked", async () => {
    const id = (await createDraft());
    changeStatus(dataDir, id, "published");
    const result = await invokeAsync<AssetUploadResult>(CHANNELS.uploadAsset, wsId, id, upload("a.png", PNG_1x1));
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
      await invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("a.png", PNG_1x1));
      expect(getPost(dataDir, id)!.frontMatter.updatedAtUtc).toBe("2030-01-01T00:00:00.000Z");

      vi.setSystemTime(new Date("2030-01-02T00:00:00.000Z"));
      await invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("a.png", Buffer.concat([PNG_1x1, Buffer.from([0])])));
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
    if (process.platform !== "win32") fs.chmodSync(sourcePath, 0o640);
    const then = new Date("2021-03-04T05:06:07.000Z");
    fs.utimesSync(sourcePath, then, then);

    await invokeUpload(wsId, id, { ...upload("pic.png", PNG_1x1), sourcePath });

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
      await invokeUpload(wsId, id, { ...upload("pic.png", bytes), sourcePath } as AssetUploadInput);
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
      await invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("a.png", PNG_1x1));
      await invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("b.txt", Buffer.from("notes")));
      const metaFile = path.join(dataDir, "assets", id, "meta.json");
      const metaBefore = fs.readFileSync(metaFile, "utf8");

      vi.setSystemTime(new Date("2030-01-02T00:00:00.000Z"));
      const result = await invokeAsync<AssetUploadResult>(CHANNELS.uploadAsset, wsId, id, upload("a.png", PNG_1x1));

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
    await invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("a.png", PNG_1x1));
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

  it("keeps an added file and says its details were not saved", async () => {
    const id = (await createDraft());
    await invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("first.png", PNG_1x1));
    const spy = failRenamesOnto("meta.json");
    let result: AssetUploadResult;
    try {
      result = await invokeAsync<AssetUploadResult>(CHANNELS.uploadAsset, wsId, id, upload("a.png", PNG_1x1));
    } finally {
      spy.mockRestore();
    }
    expect(result).toEqual({ ok: true, asset: expect.objectContaining({ filename: "a.png" }), unsaved: ["details"] });
    expect((await invoke<AssetListing>(CHANNELS.listAssets, wsId, id)).assets.map((a) => a.filename)).toEqual(["first.png", "a.png"]);
  });

  it("keeps an added file and says the post's modified time was not updated", async () => {
    const id = (await createDraft());
    const before = getPost(dataDir, id)!.frontMatter.updatedAtUtc;
    const spy = failRenamesOnto(".md");
    let result: AssetUploadResult;
    try {
      result = await invokeAsync<AssetUploadResult>(CHANNELS.uploadAsset, wsId, id, upload("a.png", PNG_1x1));
    } finally {
      spy.mockRestore();
    }
    expect(result).toEqual({ ok: true, asset: expect.objectContaining({ filename: "a.png" }), unsaved: ["modifiedTime"] });
    expect(fs.existsSync(path.join(dataDir, "assets", id, "a.png"))).toBe(true);
    expect(getPost(dataDir, id)!.frontMatter.updatedAtUtc).toBe(before);
  });

  it("keeps a deleted file deleted and says the post's modified time was not updated", async () => {
    const id = (await createDraft());
    await invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("a.png", PNG_1x1));
    await invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("b.txt", Buffer.from("notes")));
    const spy = failRenamesOnto(".md");
    let result: AssetDeleteResult;
    try {
      result = (await invoke<AssetDeleteResult>(CHANNELS.deleteAsset, wsId, id, "a.png"));
    } finally {
      spy.mockRestore();
    }
    expect(result).toEqual({ unsaved: ["modifiedTime"] });
    expect(fs.existsSync(path.join(dataDir, "assets", id, "a.png"))).toBe(false);
  });

  it("keeps a deleted file deleted when meta.json cannot be rewritten, and lists it gone", async () => {
    const id = (await createDraft());
    await invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("a.png", PNG_1x1));
    await invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("b.txt", Buffer.from("notes")));
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
    await invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("a.png", PNG_1x1));
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
    await invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("a.png", PNG_1x1));
    setLocked(dataDir, id, true);
    await expect(invoke(CHANNELS.deleteAsset, wsId, id, "a.png")).rejects.toThrow(/This post is locked/);
    expect(fs.existsSync(path.join(assetDir(dataDir, id), "a.png"))).toBe(true);
  });

  it("moves the post's modified time to the moment of the delete", async () => {
    const id = (await createDraft());
    await invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("a.png", PNG_1x1));
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
