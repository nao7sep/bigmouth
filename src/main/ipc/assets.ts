import path from "node:path";

import { ipcMain } from "electron";
import exifr from "exifr";

import {
  CHANNELS,
  type AssetDeleteResult,
  type AssetUnsavedStep,
  type AssetUploadInput,
  type AssetUploadResult,
} from "@shared/ipc";
import { isImageAssetFilename, isReservedAssetName } from "@shared/assetNames";
import { utcNow, formatUtcIso } from "../core/shared/timestamps.js";
import { getSettings } from "../storageAccess.js";
import { getPost, recordAssetChange } from "../storageAccess.js";
import {
  assetDir,
  sanitizeFilename,
  safeResolveUnder,
  type AssetMeta,
  AssetRecordError,
} from "../core/services/assetStore.js";
import { info as logInfo, warn as logWarn, error as logError, serializeError } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";
import { listAssets, saveAssetFile, deleteAsset, readSourceMetadata, fileExists } from "../storageAccess.js";
import { isPostId } from "../core/shared/filenames.js";

// Identifier validation (defense against path traversal). postId is a nanoid;
// filename is a single path component with no separators or `..`.
function readPostId(raw: unknown): string | null {
  return isPostId(raw) ? raw : null;
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

/**
 * The renderer is sandboxed but still an untrusted IPC peer. Dimensions are an
 * optional, presentation-only pair: accept both positive safe integers for an
 * image filename, or accept neither. The values never govern paths, allocation,
 * or parsing; a forged half-pair or non-image annotation never reaches disk.
 */
function readUploadDimensions(
  filename: string,
  file: AssetUploadInput,
): { width?: number; height?: number } {
  if (!isImageAssetFilename(filename)) return {};
  const { width, height } = file;
  if (
    typeof width !== "number" ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isSafeInteger(height) ||
    height <= 0
  ) {
    return {};
  }
  return { width, height };
}

/**
 * Moves the post's modified time for an asset change that already happened, and
 * says whether it could; a failure here does not undo the change.
 */
async function recordPostEdit(dir: string, wsId: string, postId: string, filename: string): Promise<boolean> {
  try {
    (await recordAssetChange(dir, postId));
    return true;
  } catch (err) {
    logError("post modified time not updated after an asset change", {
      workspace: wsId,
      postId,
      filename,
      error: serializeError(err),
    });
    return false;
  }
}

export function registerAssetHandlers(): void {
  ipcMain.handle(CHANNELS.listAssets, async (_event, wsId: string, postId: string) => {
    const dir = (await resolveWorkspace(wsId)).dataDirectory;
    const pid = readPostId(postId);
    if (!pid) throw new Error("Invalid postId");
    let listing;
    try {
      listing = (await listAssets(dir, pid));
    } catch (err) {
      logError("assets list failed", { workspace: wsId, postId: pid, error: serializeError(err) });
      throw new Error(assetStoreErrorMessage(err));
    }
    logInfo("assets listed", { workspace: wsId, postId: pid, count: listing.assets.length });
    return listing;
  });

  // Upload receives raw bytes over IPC: the renderer reads the picked File to an
  // ArrayBuffer, and the byte length is checked against the workspace's limit.
  ipcMain.handle(CHANNELS.uploadAsset, async (_event, wsId: string, postId: string, file: AssetUploadInput) => {
    const dir = (await resolveWorkspace(wsId)).dataDirectory;
    const pid = readPostId(postId);
    if (!pid) throw new Error("Invalid postId");
    if (!file || typeof file.name !== "string" || !file.data) throw new Error("No file provided");

    const buffer = Buffer.from(file.data);
    const limitMb = (await getSettings(dir)).maxUploadMb;
    if (buffer.length > limitMb * 1024 * 1024) {
      return { ok: false, admission: { code: "file-too-large", limitMb } } satisfies AssetUploadResult;
    }

    const filename = sanitizeFilename(file.name);
    if (isReservedAssetName(filename)) {
      return { ok: false, admission: { code: "reserved-name", filename } } satisfies AssetUploadResult;
    }

    const { width, height } = readUploadDimensions(filename, file);
    let hasMetadata: boolean | undefined;
    if (isImageAssetFilename(filename)) {
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

    // The lock is read HERE, with nothing awaited between it and the write. It
    // used to be checked at the top of the handler, before the exifr parse above
    // — and a lock landing inside that await then wrote an asset into a post
    // the app had already locked. Do not hoist this back up for a faster refusal.
    const post = (await getPost(dir, pid));
    if (!post) throw new Error("Post not found");
    if (post.frontMatter.locked === true) {
      return { ok: false, admission: { code: "post-locked" } } satisfies AssetUploadResult;
    }

    let saved: { asset: AssetMeta; changed: boolean };
    const unsaved: AssetUnsavedStep[] = [];
    try {
      saved = (await saveAssetFile(dir, pid, filename, buffer, meta, (await readSourceMetadata(file.sourcePath, buffer.length))));
    } catch (err) {
      logError("asset metadata save failed", { workspace: wsId, postId: pid, filename, error: serializeError(err) });
      // Past the file's install the upload stands, and only what records it is missing.
      if (err instanceof Error && err.name === "PostLockedError") return { ok: false, admission: { code: "post-locked" } } satisfies AssetUploadResult;
      if (!(err instanceof AssetRecordError)) throw new Error(assetStoreErrorMessage(err));
      saved = { asset: err.asset, changed: true };
      unsaved.push("details");
    }
    const storedMeta = saved.asset;
    // An attached file is the post's content, so a changed one edited the post.
    if (saved.changed && !(await recordPostEdit(dir, wsId, pid, storedMeta.filename))) unsaved.push("modifiedTime");
    logInfo("asset uploaded", {
      workspace: wsId,
      postId: pid,
      filename: storedMeta.filename,
      size: buffer.length,
      width: width ?? null,
      height: height ?? null,
      hasMetadata: hasMetadata ?? false,
    });
    return { ok: true, asset: storedMeta, ...(unsaved.length > 0 ? { unsaved } : {}) } satisfies AssetUploadResult;
  });

  ipcMain.handle(CHANNELS.deleteAsset, async (_event, wsId: string, postId: string, filename: string) => {
    const dir = (await resolveWorkspace(wsId)).dataDirectory;
    const pid = readPostId(postId);
    const fn = readFilename(filename);
    if (!pid || !fn) throw new Error("Invalid postId or filename");

    let filePath: string;
    try {
      filePath = safeResolveUnder(assetDir(dir, pid), fn);
    } catch {
      throw new Error("Invalid path");
    }
    if (!(await fileExists(filePath))) {
      logWarn("asset delete failed", { workspace: wsId, postId: pid, filename: fn, reason: "not-found" });
      throw new Error("Asset not found");
    }

    const post = (await getPost(dir, pid));
    if (!post) throw new Error("Post not found");
    if (post.frontMatter.locked === true) {
      throw new Error("This post is locked. Unlock it to change its assets.");
    }

    try {
      (await deleteAsset(dir, pid, fn));
    } catch (err) {
      logError("asset metadata update failed", { workspace: wsId, postId: pid, filename: fn, error: serializeError(err) });
      // Past the file's removal the delete stands; the next read reconciles meta.json.
      if (!(err instanceof AssetRecordError)) throw new Error(assetStoreErrorMessage(err));
    }
    const unsaved: AssetUnsavedStep[] = (await recordPostEdit(dir, wsId, pid, fn)) ? [] : ["modifiedTime"];
    logInfo("asset deleted", { workspace: wsId, postId: pid, filename: fn });
    return (unsaved.length > 0 ? { unsaved } : {}) satisfies AssetDeleteResult;
  });
}
