import fs from "node:fs";
import path from "node:path";

import { ipcMain } from "electron";
import exifr from "exifr";
import { imageSize } from "image-size";

import { CHANNELS, type AssetUploadInput } from "@shared/ipc";
import { utcNow, formatUtcIso } from "../core/shared/timestamps.js";
import { getSettings } from "../core/services/configStore.js";
import { getPost } from "../core/services/postStore.js";
import { isEditLocked } from "../core/shared/postLifecycle.js";
import {
  listAssets,
  saveAssetFile,
  deleteAsset,
  assetDir,
  sanitizeFilename,
  safeResolveUnder,
  type AssetMeta,
} from "../core/services/assetStore.js";
import { info as logInfo, warn as logWarn, error as logError, serializeError } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";

// Identifier validation (defense against path traversal). postId is a nanoid;
// filename is a single path component with no separators or `..`.
const POST_ID_RE = /^[A-Za-z0-9_-]+$/;
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif"]);

function readPostId(raw: unknown): string | null {
  const id = String(raw);
  return POST_ID_RE.test(id) ? id : null;
}

function readFilename(raw: unknown): string | null {
  const name = String(raw);
  if (!name) return null;
  if (name === "." || name === "..") return null;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
  if (path.basename(name) !== name) return null;
  return name;
}

function assetStoreErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Asset store error";
}

export function registerAssetHandlers(): void {
  ipcMain.handle(CHANNELS.listAssets, (_event, wsId: string, postId: string) => {
    const dir = resolveWorkspace(wsId).dataDirectory;
    const pid = readPostId(postId);
    if (!pid) throw new Error("Invalid postId");
    let assets;
    try {
      assets = listAssets(dir, pid);
    } catch (err) {
      logError("assets list failed", { workspace: wsId, postId: pid, error: serializeError(err) });
      throw new Error(assetStoreErrorMessage(err));
    }
    logInfo("assets listed", { workspace: wsId, postId: pid, count: assets.length });
    return assets;
  });

  // Upload now receives raw bytes over IPC (the renderer reads the picked File to
  // an ArrayBuffer) instead of a multipart stream — multer is gone. The byte-length
  // check replaces multer's fileSize limit.
  ipcMain.handle(CHANNELS.uploadAsset, async (_event, wsId: string, postId: string, file: AssetUploadInput) => {
    const dir = resolveWorkspace(wsId).dataDirectory;
    const pid = readPostId(postId);
    if (!pid) throw new Error("Invalid postId");
    if (!file || typeof file.name !== "string" || !file.data) throw new Error("No file provided");

    const post = getPost(dir, pid);
    if (!post) throw new Error("Post not found");
    if (isEditLocked(post.frontMatter.status)) {
      const label = post.frontMatter.status === "published" ? "Published" : "Expired";
      throw new Error(`${label} posts are locked. Move the post back to Ready or Draft to change its assets.`);
    }

    const buffer = Buffer.from(file.data);
    const limitMb = getSettings(dir).maxUploadMb ?? 500;
    if (buffer.length > limitMb * 1024 * 1024) {
      throw new Error(`File is larger than the ${limitMb} MB upload limit.`);
    }

    const filename = sanitizeFilename(file.name);

    let width: number | undefined;
    let height: number | undefined;
    let hasMetadata: boolean | undefined;
    const fileExt = path.extname(filename).slice(1).toLowerCase();
    if (IMAGE_EXTS.has(fileExt)) {
      try {
        const dims = imageSize(buffer);
        width = dims.width;
        height = dims.height;
      } catch {
        // Dimensions unavailable
      }
      try {
        const exif = await exifr.parse(buffer);
        if (exif && Object.keys(exif).length > 0) hasMetadata = true;
      } catch {
        // Not a format exifr recognises
      }
    }

    const meta = {
      filename,
      size: buffer.length,
      ...(width !== undefined && { width }),
      ...(height !== undefined && { height }),
      ...(hasMetadata && { hasMetadata }),
      uploadedAt: formatUtcIso(utcNow()),
    };

    let storedMeta: AssetMeta;
    try {
      storedMeta = saveAssetFile(dir, pid, filename, buffer, meta);
    } catch (err) {
      logError("asset metadata save failed", { workspace: wsId, postId: pid, filename, error: serializeError(err) });
      throw new Error(assetStoreErrorMessage(err));
    }
    logInfo("asset uploaded", {
      workspace: wsId,
      postId: pid,
      filename: storedMeta.filename,
      size: buffer.length,
      width: width ?? null,
      height: height ?? null,
      hasMetadata: hasMetadata ?? false,
    });
    return storedMeta;
  });

  ipcMain.handle(CHANNELS.deleteAsset, (_event, wsId: string, postId: string, filename: string) => {
    const dir = resolveWorkspace(wsId).dataDirectory;
    const pid = readPostId(postId);
    const fn = readFilename(filename);
    if (!pid || !fn) throw new Error("Invalid postId or filename");

    let filePath: string;
    try {
      filePath = safeResolveUnder(assetDir(dir, pid), fn);
    } catch {
      throw new Error("Invalid path");
    }
    if (!fs.existsSync(filePath)) {
      logWarn("asset delete failed", { workspace: wsId, postId: pid, filename: fn, reason: "not-found" });
      throw new Error("Asset not found");
    }

    const post = getPost(dir, pid);
    if (!post) throw new Error("Post not found");
    if (isEditLocked(post.frontMatter.status)) {
      const label = post.frontMatter.status === "published" ? "Published" : "Expired";
      throw new Error(`${label} posts are locked. Move the post back to Ready or Draft to change its assets.`);
    }

    try {
      deleteAsset(dir, pid, fn);
    } catch (err) {
      logError("asset metadata update failed", { workspace: wsId, postId: pid, filename: fn, error: serializeError(err) });
      throw new Error(assetStoreErrorMessage(err));
    }
    logInfo("asset deleted", { workspace: wsId, postId: pid, filename: fn });
  });
}
