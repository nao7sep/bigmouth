// Integration test for the per-post asset IPC handlers (list / upload / delete):
// the real assetStore + postStore + configStore run against a throwaway
// BIGMOUTH_HOME + a real registered workspace; only `electron` (ipcMain) and the
// logger are mocked. The upload handler receives raw bytes the way the renderer
// hands them over — an `AssetUploadInput` whose `data` is an ArrayBuffer (see
// src/renderer/src/api.ts `uploadAsset`, which reads the File to `arrayBuffer()`).
//
// A fresh workspace has no targets, so a target is registered through the real
// configStore before any post is created (createPost would otherwise reject).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNELS, type AssetUploadInput } from "@shared/ipc";
import type { AssetMeta, Post, Target } from "@shared/types";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
    on: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
  },
}));

vi.mock("@main/core/services/logger.js", () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));

import { initAppDir, createWorkspace } from "@main/core/services/workspaceStore.js";
import { saveTargets, saveSettings, getSettings } from "@main/core/services/configStore.js";
import { changeStatus, clearCache } from "@main/core/services/postStore.js";
import { assetDir } from "@main/core/services/assetStore.js";
import { registerAssetHandlers } from "@main/ipc/assets.js";
import { registerPostHandlers } from "@main/ipc/posts.js";

let home: string;
let wsId: string;
let dataDir: string;
const SAVED_HOME = process.env.BIGMOUTH_HOME;

const TARGET: Target = { name: "blogger", defaultLanguage: "en", requiresMetadata: false };

// A real 1x1 PNG, so image-size can read width/height during upload. exifr finds
// no metadata in it, so hasMetadata stays unset — both image branches exercised.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAACAAEABQABCi0q8AAAAASUVORK5CYI",
  "base64",
);

function invoke<T>(channel: string, ...args: unknown[]): T {
  return handlers.get(channel)!({}, ...args) as T;
}

async function invokeAsync<T>(channel: string, ...args: unknown[]): Promise<T> {
  return (await handlers.get(channel)!({}, ...args)) as Promise<T> as T;
}

/** Builds the byte payload the handler expects from a Buffer. */
function upload(name: string, bytes: Buffer): AssetUploadInput {
  // Slice to a tight ArrayBuffer so a pooled Node Buffer's backing store is not
  // handed across with extra bytes.
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return { name, data: ab as ArrayBuffer };
}

/** Creates a draft post through the post handler and returns its id. */
function createDraft(): string {
  const post = invoke<Post>(CHANNELS.createPost, wsId, "blogger", "en");
  return post.frontMatter.id;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ipc-assets-"));
  process.env.BIGMOUTH_HOME = home;
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
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("asset IPC handlers — workspace resolution", () => {
  it("rejects an unknown workspace id", () => {
    expect(() => invoke(CHANNELS.listAssets, "nope", "post-1")).toThrow(/workspace not found/i);
  });
});

describe("listAssets", () => {
  it("returns an empty list for a post with no assets", () => {
    const id = createDraft();
    expect(invoke<AssetMeta[]>(CHANNELS.listAssets, wsId, id)).toEqual([]);
  });

  it("rejects an invalid postId (path-traversal defense)", () => {
    expect(() => invoke(CHANNELS.listAssets, wsId, "../escape")).toThrow(/Invalid postId/);
  });
});

describe("uploadAsset", () => {
  it("stores an image, computing size + dimensions, and lists it back", async () => {
    const id = createDraft();
    const meta = await invokeAsync<AssetMeta>(CHANNELS.uploadAsset, wsId, id, upload("pic.png", PNG_1x1));

    expect(meta.filename).toBe("pic.png");
    expect(meta.size).toBe(PNG_1x1.length);
    expect(meta.width).toBe(1);
    expect(meta.height).toBe(1);
    expect(meta.uploadedAt).toBeTruthy();

    const listed = invoke<AssetMeta[]>(CHANNELS.listAssets, wsId, id);
    expect(listed.map((a) => a.filename)).toEqual(["pic.png"]);
    // The bytes actually landed on disk under assets/{postId}/.
    expect(fs.existsSync(path.join(assetDir(dataDir, id), "pic.png"))).toBe(true);
  });

  it("stores a non-image file without dimensions", async () => {
    const id = createDraft();
    const meta = await invokeAsync<AssetMeta>(
      CHANNELS.uploadAsset,
      wsId,
      id,
      upload("notes.txt", Buffer.from("hello")),
    );
    expect(meta.filename).toBe("notes.txt");
    expect(meta.size).toBe(5);
    expect(meta.width).toBeUndefined();
    expect(meta.height).toBeUndefined();
  });

  it("sanitizes the filename (strips path components)", async () => {
    const id = createDraft();
    const meta = await invokeAsync<AssetMeta>(
      CHANNELS.uploadAsset,
      wsId,
      id,
      upload("../../etc/passwd", Buffer.from("x")),
    );
    expect(meta.filename).toBe("passwd");
  });

  it("rejects an invalid postId before reaching the store", async () => {
    await expect(invokeAsync(CHANNELS.uploadAsset, wsId, "../escape", upload("a.png", PNG_1x1))).rejects.toThrow(
      /Invalid postId/,
    );
  });

  it("rejects a missing/empty file payload", async () => {
    const id = createDraft();
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
    const id = createDraft();
    // Drop the limit to 0 MB so even a tiny file trips the guard, no large buffer needed.
    const settings = getSettings(dataDir);
    saveSettings(dataDir, { ...settings, maxUploadMb: 0 });
    await expect(invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("a.png", PNG_1x1))).rejects.toThrow(
      /larger than the 0 MB upload limit/,
    );
  });

  it("refuses to upload to a published (locked) post", async () => {
    const id = createDraft();
    changeStatus(dataDir, id, "published");
    await expect(invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("a.png", PNG_1x1))).rejects.toThrow(
      /Published posts are locked/,
    );
  });

  it("refuses to upload to an expired (locked) post", async () => {
    const id = createDraft();
    changeStatus(dataDir, id, "expired");
    await expect(invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("a.png", PNG_1x1))).rejects.toThrow(
      /Expired posts are locked/,
    );
  });
});

describe("deleteAsset", () => {
  it("removes a previously uploaded asset", async () => {
    const id = createDraft();
    await invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("a.png", PNG_1x1));
    expect(invoke<AssetMeta[]>(CHANNELS.listAssets, wsId, id).map((a) => a.filename)).toEqual(["a.png"]);

    const result = invoke<void>(CHANNELS.deleteAsset, wsId, id, "a.png");
    expect(result).toBeUndefined();
    expect(invoke<AssetMeta[]>(CHANNELS.listAssets, wsId, id)).toEqual([]);
  });

  it("rejects an invalid postId or filename", () => {
    const id = createDraft();
    expect(() => invoke(CHANNELS.deleteAsset, wsId, "../escape", "a.png")).toThrow(/Invalid postId or filename/);
    expect(() => invoke(CHANNELS.deleteAsset, wsId, id, "../../etc/passwd")).toThrow(
      /Invalid postId or filename/,
    );
  });

  it("throws 'Asset not found' when the file is absent", () => {
    const id = createDraft();
    expect(() => invoke(CHANNELS.deleteAsset, wsId, id, "ghost.png")).toThrow(/Asset not found/);
  });

  it("throws 'Post not found' when the post is gone but a stray asset file lingers", async () => {
    // Reach the post-existence check after the file-existence check by writing the
    // asset file straight to disk for a post id that was never created.
    const orphanPost = "orphanpost";
    const dir = assetDir(dataDir, orphanPost);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.png"), PNG_1x1);
    expect(() => invoke(CHANNELS.deleteAsset, wsId, orphanPost, "a.png")).toThrow(/Post not found/);
  });

  it("refuses to delete an asset on a published (locked) post", async () => {
    const id = createDraft();
    await invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("a.png", PNG_1x1));
    changeStatus(dataDir, id, "published");
    expect(() => invoke(CHANNELS.deleteAsset, wsId, id, "a.png")).toThrow(/Published posts are locked/);
  });

  it("refuses to delete an asset on an expired (locked) post", async () => {
    const id = createDraft();
    await invokeAsync(CHANNELS.uploadAsset, wsId, id, upload("a.png", PNG_1x1));
    changeStatus(dataDir, id, "expired");
    expect(() => invoke(CHANNELS.deleteAsset, wsId, id, "a.png")).toThrow(/Expired posts are locked/);
  });
});
