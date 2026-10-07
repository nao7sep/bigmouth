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
import {
  assetFilenameKey,
  isReservedAssetName,
  sanitizeAssetFilename,
} from "@shared/assetNames";
import { holdsBytes, writeFileAtomic } from "../shared/atomicWrite.js";
import { NewerFormatError, jsonStoreText, readJsonStore } from "../shared/storeFormat.js";
import { moveAsideInvalid } from "../shared/quarantine.js";
import type { AssetListing } from "@shared/types";
import { isPostId } from "../shared/filenames.js";
import { serializeError, warn as logWarn } from "./logger.js";

export { isReservedAssetName } from "@shared/assetNames";
export const sanitizeFilename = sanitizeAssetFilename;

export interface AssetMeta {
  filename: string;
  size: number;           // bytes
  width?: number;         // pixels (images only)
  height?: number;        // pixels (images only)
  hasMetadata?: boolean;  // true if EXIF/IPTC/XMP metadata was detected at upload
  uploadedAt?: string;    // ISO 8601; absent when no upload was recorded (see projectAssetFile)
}


/** What a copy keeps of the user's file it was made from. */
export interface AssetSourceMetadata {
  mode: number;
  atime: Date;
  mtime: Date;
}

const META_FILENAME = "meta.json";

/**
 * The attached file was installed or removed, but `meta.json` could not be
 * written after it: the change to the file stands, and only its record is
 * missing until the next read reconciles the folder.
 */
export class AssetRecordError extends Error {
  readonly asset: AssetMeta;

  constructor(asset: AssetMeta, cause: unknown) {
    super(`The asset ${JSON.stringify(asset.filename)} changed, but meta.json could not be written`, { cause });
    this.name = "AssetRecordError";
    this.asset = asset;
  }
}

/**
 * A post's asset folder. Every asset path, and the delete of a whole post's
 * assets, goes through here, so an id outside the post-id grammar is refused
 * here rather than trusted to have been checked by each caller.
 */
export function assetDir(dataDir: string, postId: string): string {
  if (!isPostId(postId)) throw new Error(`Invalid post id ${JSON.stringify(postId)}`);
  return safeResolveUnder(path.join(dataDir, "assets"), postId);
}

function ensureAssetDir(dataDir: string, postId: string): string {
  const dir = assetDir(dataDir, postId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Lists a post's assets, reconciling `meta.json` against the files actually on
 * disk — the files are the source of truth for what is attached, while
 * `meta.json` also holds what only the upload knew: its time, the image's size
 * and whether it carried metadata.
 * Cached entries whose file is gone are dropped; files present without a cached
 * entry are projected minimally (size only). This is what makes
 * the write paths below crash-safe without any backup/rollback machinery: an
 * interrupted upload or delete heals to a consistent list on the next read, and
 * a missing `meta.json` next to real files is recovered, never an error.
 */
export function listAssets(dataDir: string, postId: string): AssetListing {
  const { assets, movedAside } = reconcileAssets(assetDir(dataDir, postId));
  return movedAside ? { assets, movedAside } : { assets };
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
 *
 * A name this directory reserves is refused outright rather than stored, because
 * a stored one could never be listed again — see isReservedAssetName.
 *
 * An uploaded file is a copy of the user's file, so it keeps the `source`
 * metadata Node can carry: the modified (and access) time and, apart from
 * Windows, the permission mode. On Windows the mode is only the read-only
 * attribute, which would leave an attachment the app could neither replace nor
 * delete. Extended attributes, Finder tags and the birth time are not carried:
 * Node cannot set them without a native dependency. A destination that refuses
 * one of these keeps the rest (content-lifecycle-conventions).
 *
 * Re-uploading the bytes an asset of the same name already holds changes nothing:
 * nothing is written, the asset keeps its place and recorded upload time, and
 * `changed` is false, so the post was not edited.
 */
export function saveAssetFile(
  dataDir: string,
  postId: string,
  filename: string,
  buffer: Buffer,
  meta: AssetMeta,
  source?: AssetSourceMetadata,
): { asset: AssetMeta; changed: boolean } {
  if (isReservedAssetName(filename)) {
    throw new Error(
      `"${filename}" is a name BigMouth keeps for its own bookkeeping. Rename the file and try again.`,
    );
  }

  const dir = ensureAssetDir(dataDir, postId);
  const { assets: siblings, newer } = reconcileAssets(dir);
  if (newer) throw newer;
  const finalName = uniqueCaseInsensitiveName(filename, siblings);
  const destPath = safeResolveUnder(dir, finalName);
  const metaPath = path.join(dir, META_FILENAME);
  const finalMeta: AssetMeta = { ...meta, filename: finalName };
  const existing = siblings.filter((a) => a.filename !== finalName);
  const current = siblings.find((a) => a.filename === finalName);
  if (current && holdsBytes(destPath, buffer)) return { asset: current, changed: false };

  // Install the file via temp+rename (atomic, and replaces any same-named file,
  // keeping its permissions), then commit the metadata. If a crash lands between
  // the two, the orphaned file is reconciled back into the list on the next read
  // — no data is lost.
  // not recorded: an uploaded asset is BINARY (an image/attachment), copied in and re-acquirable from
  // its source. Binaries are written by code paths that never call the record hook — they carry no
  // text-recovery value and would bloat the text history (data-backup conventions: binary and
  // binary-ish writes are excluded). This is the bare atomic write, not the managed-text choke point.
  writeFileAtomic(destPath, buffer);
  if (source) keepSourceMetadata(destPath, source);
  try {
    writeAssetMeta(metaPath, [...existing, finalMeta]);
  } catch (cause) {
    throw new AssetRecordError(finalMeta, cause);
  }
  return { asset: finalMeta, changed: true };
}

function keepSourceMetadata(destPath: string, source: AssetSourceMetadata): void {
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(destPath, source.mode);
    } catch (err) {
      logWarn("asset copy kept no permission mode", { path: destPath, error: serializeError(err) });
    }
  }
  try {
    fs.utimesSync(destPath, source.atime, source.mtime);
  } catch (err) {
    logWarn("asset copy kept no modified time", { path: destPath, error: serializeError(err) });
  }
}

/**
 * Returns `filename` if it doesn't case-insensitively collide with a DIFFERENT
 * sibling (an exact-name match is a replace-in-place, so it's kept as-is), else a
 * numerically-suffixed variant ("photo (1).png") that clears every sibling
 * case-insensitively. The human casing of the chosen name is preserved.
 */
function uniqueCaseInsensitiveName(filename: string, siblings: AssetMeta[]): string {
  const taken = new Set(siblings.map((a) => assetFilenameKey(a.filename)));
  const requestedKey = assetFilenameKey(filename);
  const sameSpelling = siblings.find(
    (asset) => asset.filename.normalize("NFC") === filename.normalize("NFC"),
  );
  if (sameSpelling) return sameSpelling.filename;
  if (!taken.has(requestedKey)) {
    return filename;
  }
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(assetFilenameKey(candidate))) return candidate;
  }
}

export function assertAssetDeletionAllowed(dataDir: string, postId: string): void {
  const metaPath = path.join(assetDir(dataDir, postId), META_FILENAME);
  const read = readJsonStore("assetMeta", metaPath);
  if (read.kind === "newer") throw new NewerFormatError(metaPath, read.version);
  if (read.kind === "unreadable") throw new Error("The asset metadata cannot be read", { cause: read.error });
  if (read.kind === "read" && (!Array.isArray(read.value.assets) || !read.value.assets.every(isAssetMeta))) {
    throw new Error("The asset metadata has an invalid shape");
  }
}

export function deleteAsset(dataDir: string, postId: string, filename: string): void {
  const dir = assetDir(dataDir, postId);
  const filePath = safeResolveUnder(dir, filename);
  const metaPath = path.join(dir, META_FILENAME);
  const { assets, newer } = reconcileAssets(dir);
  if (newer) throw newer;
  const remaining = assets.filter((a) => a.filename !== filename);

  // Remove the file (the durable data) first, then update the cache. A crash
  // between the two heals on the next read: the now-missing file is reconciled
  // out of the list.
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  try {
    if (remaining.length === 0) {
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } else {
      writeAssetMeta(metaPath, remaining);
    }
  } catch (cause) {
    throw new AssetRecordError(assets.find((a) => a.filename === filename) ?? { filename, size: 0 }, cause);
  }
}

/**
 * Merges the cached `meta.json` (if any) with the asset files on disk: keeps
 * cached entries whose file still exists, in their stored order, then appends a
 * projected entry for any asset file the cache doesn't know about (sorted by
 * name for determinism). The names the directory reserves for itself are
 * ignored — see isReservedAssetName, which saveAssetFile refuses to store.
 *
 * A `meta.json` a newer version of BigMouth wrote is not read, and `newer` is
 * the refusal every write to this folder raises, so the file stays exactly as it is.
 */
function reconcileAssets(dir: string): {
  assets: AssetMeta[];
  newer: NewerFormatError | null;
  movedAside?: { path: string; movedTo: string };
} {
  if (!fs.existsSync(dir)) return { assets: [], newer: null };

  const onDisk = new Set(fs.readdirSync(dir).filter((entry) => !isReservedAssetName(entry)));

  const { cached, newer, movedAside } = readAssetMeta(path.join(dir, META_FILENAME));
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
  return { assets: result, newer, movedAside };
}

/**
 * The recorded entries of `meta.json`. Its upload times are facts the app
 * recorded and nothing can rebuild, so a file that cannot be read, or whose
 * entries are not asset records, is moved aside before anything is listed or
 * written (store-recovery-conventions); a failed move throws QuarantineError
 * and nothing is written. The files are then listed from the folder, as when
 * `meta.json` is absent.
 */
function readAssetMeta(metaPath: string): {
  cached: AssetMeta[];
  newer: NewerFormatError | null;
  movedAside?: { path: string; movedTo: string };
} {
  const read = readJsonStore("assetMeta", metaPath);
  switch (read.kind) {
    case "absent":
      return { cached: [], newer: null };
    case "newer":
      logWarn("asset metadata was written by a newer version of BigMouth; left unchanged, assets listed from the files on disk", {
        path: metaPath,
        formatVersion: read.version,
      });
      return { cached: [], newer: new NewerFormatError(metaPath, read.version) };
    case "unreadable":
      return moveAsideUnreadableMeta(metaPath, read.detail, read.error);
    case "read": {
      const assets = read.value.assets;
      if (!Array.isArray(assets)) return moveAsideUnreadableMeta(metaPath, "its assets key is not an array", null);
      if (!assets.every(isAssetMeta)) return moveAsideUnreadableMeta(metaPath, "one of its assets is not an asset record", null);
      return { cached: assets, newer: null };
    }
  }
}

function moveAsideUnreadableMeta(
  metaPath: string,
  detail: string,
  error: unknown,
): { cached: AssetMeta[]; newer: null; movedAside: { path: string; movedTo: string } } {
  const movedTo = moveAsideInvalid(metaPath);
  logWarn("asset metadata unreadable; moved aside, assets listed from the files on disk", {
    path: metaPath,
    movedTo,
    detail,
    ...(error ? { error: serializeError(error) } : {}),
  });
  return { cached: [], newer: null, movedAside: { path: metaPath, movedTo } };
}

function isAssetMeta(value: unknown): value is AssetMeta {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const { filename, size, width, height, hasMetadata, uploadedAt } = value as Record<string, unknown>;
  const isDimension = (n: unknown) => n === undefined || (typeof n === "number" && Number.isSafeInteger(n) && n > 0);
  return (
    typeof filename === "string" &&
    filename.length > 0 &&
    typeof size === "number" &&
    Number.isSafeInteger(size) &&
    size >= 0 &&
    isDimension(width) &&
    isDimension(height) &&
    (hasMetadata === undefined || typeof hasMetadata === "boolean") &&
    (uploadedAt === undefined || typeof uploadedAt === "string")
  );
}

/**
 * Minimal metadata for an asset file with no cached entry: its size. It has no
 * upload time, because none was recorded — the file's modified time is when it
 * was last written, which a copy or a git checkout resets, so it is not taken
 * for one (content-lifecycle-conventions: a missing time is not made up). The
 * next upload or delete writes this entry to `meta.json` as it is.
 */
function projectAssetFile(dir: string, filename: string): AssetMeta {
  return { filename, size: fs.statSync(path.join(dir, filename)).size };
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
  writeFileAtomic(metaPath, jsonStoreText("assetMeta", { assets }));
}

