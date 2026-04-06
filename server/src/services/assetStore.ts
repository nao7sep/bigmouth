/**
 * Asset file I/O.
 *
 * Assets are stored under:
 *   {dataDir}/assets/{postId}/{filename}
 *
 * A sidecar file {dataDir}/assets/{postId}/meta.json holds cached metadata
 * so list requests don't need to re-read EXIF on every call.
 */

import fs from "node:fs";
import path from "node:path";

export interface AssetMeta {
  filename: string;
  size: number;        // bytes
  width?: number;      // pixels
  height?: number;     // pixels
  takenAt?: string;    // ISO 8601, from EXIF DateTimeOriginal
  uploadedAt: string;  // ISO 8601
}

const META_FILENAME = "meta.json";

let assetsRoot = "";

export function initAssetStore(dataDirectory: string): void {
  assetsRoot = path.join(dataDirectory, "assets");
}

export function assetDir(postId: string): string {
  const dir = path.join(assetsRoot, postId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function assetFilePath(postId: string, filename: string): string {
  return path.join(assetDir(postId), filename);
}

export function listAssets(postId: string): AssetMeta[] {
  const metaPath = path.join(assetDir(postId), META_FILENAME);
  if (!fs.existsSync(metaPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as AssetMeta[];
  } catch {
    return [];
  }
}

export function addAsset(postId: string, meta: AssetMeta): void {
  const dir = assetDir(postId);
  const metaPath = path.join(dir, META_FILENAME);
  const existing = listAssets(postId).filter((a) => a.filename !== meta.filename);
  fs.writeFileSync(metaPath, JSON.stringify([...existing, meta], null, 2) + "\n");
}

export function deleteAsset(postId: string, filename: string): void {
  const dir = assetDir(postId);
  const filePath = path.join(dir, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  const metaPath = path.join(dir, META_FILENAME);
  const remaining = listAssets(postId).filter((a) => a.filename !== filename);
  fs.writeFileSync(metaPath, JSON.stringify(remaining, null, 2) + "\n");
}

/**
 * Sanitizes an uploaded filename: keeps the basename, replaces any character
 * that isn't alphanumeric, dot, underscore, or hyphen with an underscore.
 */
export function sanitizeFilename(raw: string): string {
  const base = path.basename(raw);
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}
