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

export function listAssets(dataDir: string, postId: string): AssetMeta[] {
  const dir = assetDir(dataDir, postId);
  const metaPath = path.join(dir, META_FILENAME);
  if (!fs.existsSync(metaPath)) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).some((entry) => entry !== META_FILENAME)) {
      throw new Error(`Asset metadata missing for non-empty asset directory: ${dir}`);
    }
    return [];
  }
  return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as AssetMeta[];
}

export function saveAssetFile(
  dataDir: string,
  postId: string,
  filename: string,
  buffer: Buffer,
  meta: AssetMeta
): void {
  const dir = ensureAssetDir(dataDir, postId);
  const destPath = safeResolveUnder(dir, filename);
  const metaPath = path.join(dir, META_FILENAME);
  const existing = listAssets(dataDir, postId).filter((a) => a.filename !== filename);
  const tempPath = path.join(dir, tempName(filename, "upload"));
  const backupPath = fs.existsSync(destPath)
    ? path.join(dir, tempName(filename, "backup"))
    : null;

  let newFileInstalled = false;
  let oldFileBackedUp = false;

  fs.writeFileSync(tempPath, buffer);
  try {
    if (backupPath) {
      fs.renameSync(destPath, backupPath);
      oldFileBackedUp = true;
    }
    fs.renameSync(tempPath, destPath);
    newFileInstalled = true;
    writeAssetMeta(metaPath, [...existing, meta]);
    if (backupPath && fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  } catch (err) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    if (newFileInstalled && fs.existsSync(destPath)) fs.unlinkSync(destPath);
    if (oldFileBackedUp && backupPath && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, destPath);
    }
    throw err;
  }
}

export function deleteAsset(dataDir: string, postId: string, filename: string): void {
  const dir = assetDir(dataDir, postId);
  const filePath = safeResolveUnder(dir, filename);
  const metaPath = path.join(dir, META_FILENAME);
  const remaining = listAssets(dataDir, postId).filter((a) => a.filename !== filename);
  const backupPath = fs.existsSync(filePath)
    ? path.join(dir, tempName(filename, "delete"))
    : null;
  let fileBackedUp = false;

  try {
    if (backupPath) {
      fs.renameSync(filePath, backupPath);
      fileBackedUp = true;
    }
    writeAssetMeta(metaPath, remaining);
    if (backupPath && fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  } catch (err) {
    if (fileBackedUp && backupPath && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, filePath);
    }
    throw err;
  }

  if (remaining.length === 0 && fs.existsSync(metaPath)) {
    fs.unlinkSync(metaPath);
  }
  if (remaining.length === 0 && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
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

/**
 * Resolves a path under `root` and refuses anything that escapes it.
 * Use this whenever any segment of the final path comes from user input.
 */
export function safeResolveUnder(root: string, ...segments: string[]): string {
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, ...segments);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error("Path escape detected");
  }
  return resolved;
}

function writeAssetMeta(metaPath: string, assets: AssetMeta[]): void {
  const tempPath = `${metaPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(assets, null, 2) + "\n");
  fs.renameSync(tempPath, metaPath);
}

function tempName(filename: string, purpose: string): string {
  const safeName = sanitizeFilename(filename);
  return `.${purpose}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`;
}
