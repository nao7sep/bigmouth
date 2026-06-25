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

/**
 * Lists a post's assets, reconciling the cached `meta.json` against the files
 * actually on disk — the image files are the source of truth, `meta.json` is a
 * derived cache (the same relationship the post index has with the `.md` files).
 * Cached entries whose file is gone are dropped; files present without a cached
 * entry are projected minimally (size + mtime, no dimensions). This is what makes
 * the write paths below crash-safe without any backup/rollback machinery: an
 * interrupted upload or delete heals to a consistent list on the next read, and
 * a missing `meta.json` next to real files is recovered, never an error.
 */
export function listAssets(dataDir: string, postId: string): AssetMeta[] {
  return reconcileAssets(assetDir(dataDir, postId));
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
  const existing = reconcileAssets(dir).filter((a) => a.filename !== filename);

  // Install the file via temp+rename (atomic, and replaces any same-named file),
  // then commit the metadata. If a crash lands between the two, the orphaned file
  // is reconciled back into the list on the next read — no data is lost.
  const tempPath = path.join(dir, tempName(filename, "upload"));
  try {
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, destPath);
  } catch (err) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    throw err;
  }
  writeAssetMeta(metaPath, [...existing, meta]);
}

export function deleteAsset(dataDir: string, postId: string, filename: string): void {
  const dir = assetDir(dataDir, postId);
  const filePath = safeResolveUnder(dir, filename);
  const metaPath = path.join(dir, META_FILENAME);
  const remaining = reconcileAssets(dir).filter((a) => a.filename !== filename);

  // Remove the file (the durable data) first, then update the cache. A crash
  // between the two heals on the next read: the now-missing file is reconciled
  // out of the list.
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  if (remaining.length === 0) {
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } else {
    writeAssetMeta(metaPath, remaining);
  }
}

/**
 * Merges the cached `meta.json` (if any) with the asset files on disk: keeps
 * cached entries whose file still exists, in their stored order, then appends a
 * projected entry for any asset file the cache doesn't know about (sorted by
 * name for determinism). Dotfiles (temp files) and `meta.json` are ignored.
 */
function reconcileAssets(dir: string): AssetMeta[] {
  if (!fs.existsSync(dir)) return [];

  const onDisk = new Set(
    fs.readdirSync(dir).filter((entry) => entry !== META_FILENAME && !entry.startsWith(".")),
  );

  const cached = readAssetMeta(path.join(dir, META_FILENAME));
  const result: AssetMeta[] = [];
  const accountedFor = new Set<string>();
  for (const entry of cached) {
    if (onDisk.has(entry.filename)) {
      result.push(entry);
      accountedFor.add(entry.filename);
    }
  }
  for (const filename of [...onDisk].sort()) {
    if (accountedFor.has(filename)) continue;
    result.push(projectAssetFile(dir, filename));
  }
  return result;
}

function readAssetMeta(metaPath: string): AssetMeta[] {
  if (!fs.existsSync(metaPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    return Array.isArray(parsed) ? (parsed as AssetMeta[]) : [];
  } catch {
    // Corrupt cache — treat as absent and rebuild from the files on disk.
    return [];
  }
}

/** Minimal metadata for an asset file with no cached entry (size + mtime). */
function projectAssetFile(dir: string, filename: string): AssetMeta {
  const stat = fs.statSync(path.join(dir, filename));
  return {
    filename,
    size: stat.size,
    uploadedAt: stat.mtime.toISOString(),
  };
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
