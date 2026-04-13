/**
 * Asset file I/O.
 *
 * Assets are stored under:
 *   {dataDir}/assets/{postId}/{filename}
 *
 * A sidecar file {dataDir}/assets/{postId}/meta.json holds cached metadata
 * (size, dimensions, metadata warning flag) so list requests are fast.
 *
 * All public functions take a dataDir parameter (the workspace data directory).
 */

import fs from "node:fs";
import path from "node:path";
import { warn as logWarn } from "./logger.js";

export interface AssetMeta {
  filename: string;
  size: number;           // bytes
  width?: number;         // pixels (images only)
  height?: number;        // pixels (images only)
  hasMetadata?: boolean;  // true if EXIF/IPTC/XMP metadata was detected at upload
  uploadedAt: string;     // ISO 8601
}

const META_FILENAME = "meta.json";

export function assetDir(dataDir: string, postId: string): string {
  return path.join(dataDir, "assets", postId);
}

function ensureAssetDir(dataDir: string, postId: string): string {
  const dir = assetDir(dataDir, postId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function assetFilePath(dataDir: string, postId: string, filename: string): string {
  return path.join(ensureAssetDir(dataDir, postId), filename);
}

export function listAssets(dataDir: string, postId: string): AssetMeta[] {
  const metaPath = path.join(assetDir(dataDir, postId), META_FILENAME);
  if (!fs.existsSync(metaPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as AssetMeta[];
  } catch (err) {
    logWarn(`Malformed asset metadata file: ${metaPath} — ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

export function addAsset(dataDir: string, postId: string, meta: AssetMeta): void {
  const dir = ensureAssetDir(dataDir, postId);
  const metaPath = path.join(dir, META_FILENAME);
  const existing = listAssets(dataDir, postId).filter((a) => a.filename !== meta.filename);
  fs.writeFileSync(metaPath, JSON.stringify([...existing, meta], null, 2) + "\n");
}

export function deleteAsset(dataDir: string, postId: string, filename: string): void {
  const dir = assetDir(dataDir, postId);
  const filePath = path.join(dir, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  const metaPath = path.join(dir, META_FILENAME);
  const remaining = listAssets(dataDir, postId).filter((a) => a.filename !== filename);

  if (remaining.length === 0) {
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    if (fs.existsSync(dir)) fs.rmdirSync(dir);
  } else {
    fs.writeFileSync(metaPath, JSON.stringify(remaining, null, 2) + "\n");
  }
}

/**
 * Sanitizes an uploaded filename: keeps the basename, replaces any character
 * that isn't alphanumeric, dot, underscore, or hyphen with an underscore.
 */
export function sanitizeFilename(raw: string): string {
  const base = path.basename(raw);
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}
