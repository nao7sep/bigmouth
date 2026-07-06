/**
 * Asset file I/O.
 *
 * Assets are stored under:
 *   {dataDir}/assets/{postId}/{filename}
 *
 * This is a workspace-level `assets/` collection keyed by post id, deliberately PARALLEL
 * to `posts/` — not nested as `posts/{postId}/{postId}.md` + `posts/{postId}/assets/`.
 * Most posts have no attachments, so nesting only the posts that DO would force a bare
 * `post-A.md` file and a `post-B/` directory to sit side by side in one workspace folder —
 * a file and a per-post directory mixed together, inconsistent and awkward. Keeping posts
 * and assets as two flat, parallel collections linked by post id makes the layout uniform.
 * Assets are binary and are not backed up (see the record-hook notes below); only the
 * posts' text is recorded by the write-through data-backup store.
 *
 * A sidecar file {dataDir}/assets/{postId}/meta.json holds cached metadata
 * (size, dimensions, metadata warning flag) so list requests are fast.
 *
 * All public functions take a dataDir parameter (the workspace data directory).
 */

import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { writeFileAtomic } from "../shared/atomicWrite.js";

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

/**
 * Installs an uploaded asset and commits its metadata, returning the metadata as
 * actually stored — `filename` may be disambiguated (see below), so callers must
 * use the returned `filename`, not the one they passed in.
 *
 * Filenames are case-insensitively unique within a post's asset dir (a set built
 * on Linux must not collide on case-insensitive macOS/Windows). A re-upload with
 * the exact same name replaces in place; a name that differs ONLY in case from a
 * DIFFERENT existing asset is disambiguated with a numeric suffix ("photo (1).png").
 */
export function saveAssetFile(
  dataDir: string,
  postId: string,
  filename: string,
  buffer: Buffer,
  meta: AssetMeta
): AssetMeta {
  const dir = ensureAssetDir(dataDir, postId);
  const siblings = reconcileAssets(dir);
  const finalName = uniqueCaseInsensitiveName(filename, siblings);
  const destPath = safeResolveUnder(dir, finalName);
  const metaPath = path.join(dir, META_FILENAME);
  const finalMeta: AssetMeta = { ...meta, filename: finalName };
  const existing = siblings.filter((a) => a.filename !== finalName);

  // Install the file via temp+rename (atomic, and replaces any same-named file),
  // then commit the metadata. If a crash lands between the two, the orphaned file
  // is reconciled back into the list on the next read — no data is lost.
  const tempPath = path.join(dir, tempName(finalName));
  try {
    // not recorded: an uploaded asset is BINARY (an image/attachment), copied in and re-acquirable from
    // its source. Binaries are written by code paths that never call the record hook — they carry no
    // text-recovery value and would bloat the text history (data-backup conventions: binary and
    // binary-ish writes are excluded). This is a raw fs write, not the managed-text choke point.
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, destPath);
  } catch (err) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    throw err;
  }
  writeAssetMeta(metaPath, [...existing, finalMeta]);
  return finalMeta;
}

/**
 * Returns `filename` if it doesn't case-insensitively collide with a DIFFERENT
 * sibling (an exact-name match is a replace-in-place, so it's kept as-is), else a
 * numerically-suffixed variant ("photo (1).png") that clears every sibling
 * case-insensitively. The human casing of the chosen name is preserved.
 */
function uniqueCaseInsensitiveName(filename: string, siblings: AssetMeta[]): string {
  const taken = new Set(siblings.map((a) => a.filename.toLowerCase()));
  if (!taken.has(filename.toLowerCase()) || siblings.some((a) => a.filename === filename)) {
    return filename;
  }
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
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
 * name for determinism). Dotfiles and `*.tmp` atomic-write temporaries (an
 * in-flight or crash-orphaned upload, per `tempName` below) and `meta.json`
 * are ignored.
 */
function reconcileAssets(dir: string): AssetMeta[] {
  if (!fs.existsSync(dir)) return [];

  const onDisk = new Set(
    fs.readdirSync(dir).filter(
      (entry) =>
        entry !== META_FILENAME && !entry.startsWith(".") && !entry.toLowerCase().endsWith(".tmp"),
    ),
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
  // not recorded: meta.json is a sidecar colocated in the binary-bearing assets/<postId>/ directory.
  // A directory that holds binaries is excluded wholesale, sidecars included — this cache is meaningless
  // without the images (which are excluded) and is regenerable from them (reconcileAssets rebuilds it),
  // so it rides along into exclusion rather than being recorded orphaned (data-backup conventions:
  // anything colocated in a binary-bearing directory is excluded). Kept on the bare atomic write.
  writeFileAtomic(metaPath, JSON.stringify(assets, null, 2) + "\n");
}

// The derived-filename grammar's atomic-write shape: `<stem>-<nanoid>.tmp`, same
// directory as the final asset file. The nanoid is what lets two uploads of the
// same name race safely — each writes its own temp and only one rename wins.
function tempName(filename: string): string {
  const safeName = sanitizeFilename(filename);
  const ext = path.extname(safeName);
  const stem = path.basename(safeName, ext);
  return `${stem}-${nanoid()}.tmp`;
}
