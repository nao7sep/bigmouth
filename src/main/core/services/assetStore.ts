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
 * Assets are files the user added, so each is recorded in the data-backup history when it is
 * saved, and so is meta.json each time it is written (data-backup-conventions).
 *
 * A sidecar file {dataDir}/assets/{postId}/meta.json holds each asset's upload time, size,
 * dimensions and metadata warning flag. The upload time is a recorded fact: a file missing from
 * meta.json is listed with its size only, so the backup is what can bring the rest back.
 *
 * An upload reaches the workspace as a staged file, {dataDir}/.staging/{nanoid}.part, which the main
 * process writes from the renderer's stream, hashing it as it goes, and {@link installAsset} renames
 * into place. The staging folder sits on the workspace's own volume, so that rename is atomic, and
 * outside assets/, so a partial upload is never listed.
 *
 * All public functions take a dataDir parameter (the workspace data directory).
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  assetFilenameKey,
  isImageAssetFilename,
  isReservedAssetName,
  sanitizeAssetFilename,
} from "@shared/assetNames";
import { existingMode, writeManagedText } from "../shared/atomicWrite.js";
import { createHash } from "node:crypto";
import { recordFile } from "./backupStore.js";
import { NewerFormatError, UnreadableStoreError, jsonStoreText, readJsonStore } from "../shared/storeFormat.js";
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
  animated?: boolean;     // images only: whether it has more than one frame, read at upload
  hasMetadata?: boolean;  // true if EXIF/IPTC/XMP metadata was detected at upload
  uploadedAt?: string;    // ISO 8601; absent when no upload was recorded (see projectAssetFile)
  contentHash?: string;   // SHA-256 of the bytes these details describe; addresses its thumbnails
}


/** What a copy keeps of the user's file it was made from. */
export interface AssetSourceMetadata {
  mode: number;
  atime: Date;
  mtime: Date;
}

/**
 * An asset as `meta.json` records it. `contentHash` is the SHA-256 of the bytes the
 * details describe, and `mtimeMs` the file's modified time when that hash was
 * taken; `size` is its size then.
 */
interface RecordedAsset extends AssetMeta { mtimeMs?: number }
const META_FILENAME = "meta.json";

/** An upload's bytes as the main process staged them: the staged file's name, their SHA-256 and their length. */
export interface StagedUpload {
  name: string;
  sha256: string;
  size: number;
}

const STAGING_DIR = ".staging";
// The names the main process gives staged uploads; nothing else in the folder is touched.
const STAGED_NAME = /^[A-Za-z0-9_-]+\.part$/;

/** Where uploads into this workspace are staged before they are installed. */
export function stagingDir(dataDir: string): string {
  return path.join(dataDir, STAGING_DIR);
}

function stagedPath(dataDir: string, name: string): string {
  if (!STAGED_NAME.test(name)) throw new Error(`Invalid staged upload name ${JSON.stringify(name)}`);
  return path.join(stagingDir(dataDir), name);
}

/**
 * Removes staged uploads an earlier launch left behind, as when it ended during
 * an upload, and returns how many it removed. Only files older than this
 * process are taken: every staged file this launch writes is newer, since each
 * write moves its modified time, so a live upload's file is never removed
 * (storage-path-conventions).
 */
export function sweepStaging(dataDir: string): number {
  const dir = stagingDir(dataDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  const launchedAt = Date.now() - process.uptime() * 1000;
  let removed = 0;
  for (const name of names) {
    if (!STAGED_NAME.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.mtimeMs >= launchedAt) continue;
      fs.rmSync(file, { force: true });
      removed += 1;
    } catch (err) {
      logWarn("leftover staged upload could not be removed", { path: file, error: serializeError(err) });
    }
  }
  return removed;
}

// Details describe bytes, not inode or filesystem timestamps: copying a workspace
// must preserve its upload facts. Read in bounded chunks on the storage worker.
function contentHash(filePath: string): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let count: number;
    while ((count = fs.readSync(fd, chunk, 0, chunk.length, null)) !== 0) hash.update(chunk.subarray(0, count));
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}

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
  const listed = assets.map(details);
  return movedAside ? { assets: listed, movedAside } : { assets: listed };
}

/**
 * What the interface is told about a recorded asset: everything but the record's
 * own bookkeeping. The hash is told, because the window asks for an image's
 * thumbnail and display image by it (see imageDerivatives).
 */
function details({ mtimeMs: _mtime, ...asset }: RecordedAsset): AssetMeta {
  return asset;
}

/**
 * Installs a staged upload as an asset and commits its metadata, returning the
 * metadata as actually stored — `filename` may be disambiguated (see below), so
 * callers must use the returned `filename`, not the one they passed in.
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
 * `changed` is false, so the post was not edited. The staged file is then left
 * for its owner, the upload, to remove. Whether the bytes are the same is
 * decided by hash, from the asset's verified record, without reading the file
 * again unless no hash was ever recorded for it.
 */
export function installAsset(
  dataDir: string,
  postId: string,
  filename: string,
  staged: StagedUpload,
  meta: AssetMeta,
  source?: AssetSourceMetadata,
): { asset: AssetMeta; changed: boolean } {
  if (isReservedAssetName(filename)) {
    throw new Error(
      `"${filename}" is a name BigMouth keeps for its own bookkeeping. Rename the file and try again.`,
    );
  }

  const fromPath = stagedPath(dataDir, staged.name);
  const dir = ensureAssetDir(dataDir, postId);
  const { assets: siblings, records, refusal } = reconcileAssets(dir);
  if (refusal) throw refusal;
  const finalName = uniqueCaseInsensitiveName(filename, siblings);
  const destPath = safeResolveUnder(dir, finalName);
  const metaPath = path.join(dir, META_FILENAME);
  const finalMeta: AssetMeta = { ...meta, filename: finalName, size: staged.size, contentHash: staged.sha256 };
  const existing = records.filter((a) => a.filename !== finalName);
  const current = siblings.find((a) => a.filename === finalName);
  if (current && current.size === staged.size && (current.contentHash ?? hashIfReadable(destPath)) === staged.sha256) {
    return { asset: details(current), changed: false };
  }

  // Install the file by renaming the staged copy into place (atomic, and replaces
  // any same-named file, keeping its permissions), then commit the metadata. If a
  // crash lands between the two, the orphaned file is reconciled back into the
  // list on the next read — no data is lost. The stage was written private; it
  // takes the replaced file's mode, or the ordinary one, before it is published.
  fs.chmodSync(fromPath, existingMode(destPath) ?? (0o666 & ~process.umask()));
  fs.renameSync(fromPath, destPath);
  // The descriptor is taken before anything else can reach the new file, so the
  // backup reads the bytes installed here even if the asset is replaced or
  // deleted before the recorder gets to it.
  const installed = openForBackup(destPath);
  if (source) keepSourceMetadata(destPath, source);
  // The modified time is read after the source's is applied: it is the one the
  // file keeps, and what reconcileAssets compares to trust this hash later.
  const { mtimeMs } = installed === null ? fs.statSync(destPath) : fs.fstatSync(installed);
  // recorded: an uploaded asset is a file the user added; deleting its post would otherwise lose it.
  if (installed !== null) recordFile(destPath, installed, staged.sha256, staged.size);
  try {
    writeAssetMeta(metaPath, [...existing, { ...finalMeta, mtimeMs }]);
  } catch (cause) {
    throw new AssetRecordError(finalMeta, cause);
  }
  return { asset: finalMeta, changed: true };
}

function hashIfReadable(filePath: string): string | null {
  try { return contentHash(filePath); } catch { return null; }
}

function openForBackup(filePath: string): number | null {
  try {
    return fs.openSync(filePath, "r");
  } catch (err) {
    logWarn("installed asset could not be opened for the backup; not recorded", { path: filePath, error: serializeError(err) });
    return null;
  }
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

export function deleteAsset(dataDir: string, postId: string, filename: string): void {
  const dir = assetDir(dataDir, postId);
  const filePath = safeResolveUnder(dir, filename);
  const metaPath = path.join(dir, META_FILENAME);
  const { assets, records, refusal } = reconcileAssets(dir);
  if (refusal) throw refusal;
  const remaining = records.filter((a) => a.filename !== filename);

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
 * ignored — see isReservedAssetName, which installAsset refuses to store.
 *
 * A `meta.json` a newer version of BigMouth wrote, or one that could not be
 * read at all, is not used, and `refusal` is what every write to this folder
 * raises, so the file stays exactly as it is.
 */
function reconcileAssets(dir: string): {
  assets: RecordedAsset[];
  records: RecordedAsset[];
  refusal: Error | null;
  movedAside?: { path: string; movedTo: string };
} {
  if (!fs.existsSync(dir)) return { assets: [], records: [], refusal: null };

  const onDisk = new Set(fs.readdirSync(dir).filter((entry) => !isReservedAssetName(entry)));

  const { cached, refusal, movedAside } = readAssetMeta(path.join(dir, META_FILENAME));
  const result: RecordedAsset[] = [];
  const records: RecordedAsset[] = [];
  const accountedFor = new Set<string>();
  for (const entry of cached) {
    if (onDisk.has(entry.filename)) {
      // A replacement can commit before its sidecar, and a file can be replaced
      // outside the app. A row whose hash no longer matches describes different
      // bytes; unknown upload facts are safer than invented continuity.
      const filePath = path.join(dir, entry.filename);
      const checked = checkRecordedHash(filePath, entry);
      const asset = checked.kind === "verified" ? checked.record : checked.kind === "changed" ? checked.projection : projectAssetFile(dir, entry.filename);
      result.push(asset);
      // An unreadable file does not prove its bytes changed. Hide its details
      // until verification succeeds, but retain the facts through sibling writes.
      records.push(checked.kind === "unreadable" ? entry : asset);
      accountedFor.add(entry.filename);
    }
  }
  for (const filename of [...onDisk].sort()) {
    if (accountedFor.has(filename)) continue;
    const asset = projectAssetFile(dir, filename);
    result.push(asset);
    records.push(asset);
  }
  return { assets: result, records, refusal, movedAside };
}

/**
 * Whether a recorded hash still describes the file. It is trusted without reading
 * the file while the file's size and modified time are the ones recorded with it,
 * and recomputed, reading the file in chunks, when either differs, which catches
 * a replacement in BigMouth or an edit from Finder or git. A replacement of the
 * same size within the filesystem's modified-time resolution is not caught; that
 * is accepted, as by the tools that use the same check. A recomputed hash that
 * matches gives the record the current modified time, which the next write of
 * `meta.json` keeps, so a checkout that only moved the time is read once more
 * at most. One that differs becomes the file's new record: its size and hash,
 * with no upload facts.
 */
function checkRecordedHash(filePath: string, entry: RecordedAsset):
  | { kind: "verified"; record: RecordedAsset }
  | { kind: "changed"; projection: RecordedAsset }
  | { kind: "unverifiable" }
  | { kind: "unreadable" } {
  if (entry.contentHash === undefined) return { kind: "unverifiable" };
  try {
    // Taken before hashing: a change during the read leaves a newer time than
    // the one recorded here, so it is hashed again next time.
    const stat = fs.statSync(filePath);
    if (entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) return { kind: "verified", record: entry };
    const actual = contentHash(filePath);
    if (actual === entry.contentHash) return { kind: "verified", record: { ...entry, mtimeMs: stat.mtimeMs } };
    return { kind: "changed", projection: { filename: entry.filename, size: stat.size, contentHash: actual, mtimeMs: stat.mtimeMs } };
  } catch (error) {
    logWarn("asset details could not be verified; upload facts left unknown", { path: filePath, error: serializeError(error) });
    return { kind: "unreadable" };
  }
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
  cached: RecordedAsset[];
  refusal: Error | null;
  movedAside?: { path: string; movedTo: string };
} {
  const read = readJsonStore("assetMeta", metaPath);
  switch (read.kind) {
    case "absent":
      return { cached: [], refusal: null };
    case "newer":
      logWarn("asset metadata was written by a newer version of BigMouth; left unchanged, assets listed from the files on disk", {
        path: metaPath,
        formatVersion: read.version,
      });
      return { cached: [], refusal: new NewerFormatError(metaPath, read.version) };
    case "inaccessible":
      // A failed read says nothing about the bytes: the file is left as it is,
      // the assets are listed from the folder, and writes to it are refused.
      logWarn("asset metadata could not be read; left unchanged, assets listed from the files on disk", {
        path: metaPath,
        detail: read.detail,
        error: serializeError(read.error),
      });
      return { cached: [], refusal: new UnreadableStoreError(metaPath, read.detail, read.error) };
    case "unreadable":
      return moveAsideUnreadableMeta(metaPath, read.detail, read.error);
    case "read": {
      const assets = read.value.assets;
      if (!Array.isArray(assets)) return moveAsideUnreadableMeta(metaPath, "its assets key is not an array", null);
      if (!assets.every(isAssetMeta)) return moveAsideUnreadableMeta(metaPath, "one of its assets is not an asset record", null);
      return { cached: assets, refusal: null };
    }
  }
}

function moveAsideUnreadableMeta(
  metaPath: string,
  detail: string,
  error: unknown,
): { cached: RecordedAsset[]; refusal: null; movedAside: { path: string; movedTo: string } } {
  const movedTo = moveAsideInvalid(metaPath);
  logWarn("asset metadata unreadable; moved aside, assets listed from the files on disk", {
    path: metaPath,
    movedTo,
    detail,
    ...(error ? { error: serializeError(error) } : {}),
  });
  return { cached: [], refusal: null, movedAside: { path: metaPath, movedTo } };
}

function isAssetMeta(value: unknown): value is RecordedAsset {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const { filename, size, width, height, animated, hasMetadata, uploadedAt, contentHash, mtimeMs } = value as Record<string, unknown>;
  const isDimension = (n: unknown) => n === undefined || (typeof n === "number" && Number.isSafeInteger(n) && n > 0);
  return (
    typeof filename === "string" &&
    filename.length > 0 &&
    typeof size === "number" &&
    Number.isSafeInteger(size) &&
    size >= 0 &&
    isDimension(width) &&
    isDimension(height) &&
    (animated === undefined || typeof animated === "boolean") &&
    (hasMetadata === undefined || typeof hasMetadata === "boolean") &&
    (uploadedAt === undefined || typeof uploadedAt === "string") &&
    (contentHash === undefined || typeof contentHash === "string") &&
    (mtimeMs === undefined || (typeof mtimeMs === "number" && Number.isFinite(mtimeMs)))
  );
}

/**
 * Minimal metadata for an asset file with no cached entry: its size, and for an
 * image its hash, which its thumbnail is asked for by. It has no upload time,
 * because none was recorded — the file's modified time is when it was last
 * written, which a copy or a git checkout resets, so it is not taken for one
 * (content-lifecycle-conventions: a missing time is not made up). The next
 * upload or delete writes this entry to `meta.json` as it is, hash included, so
 * an image added from Finder is read whole at each listing only until then;
 * other files are not hashed here, since nothing needs their hash. A hash that
 * cannot be taken leaves the image without one; it then shows its file tile.
 */
function projectAssetFile(dir: string, filename: string): RecordedAsset {
  const filePath = path.join(dir, filename);
  const stat = fs.statSync(filePath);
  if (!isImageAssetFilename(filename)) return { filename, size: stat.size };
  const hash = hashIfReadable(filePath);
  return hash === null ? { filename, size: stat.size } : { filename, size: stat.size, contentHash: hash, mtimeMs: stat.mtimeMs };
}

/**
 * Calls `visit` with every content hash the `meta.json` files of a workspace
 * record, reading them one at a time without the storage worker: the thumbnail
 * sweep runs in the main process and only needs to know which hashes are still
 * named. A post whose `meta.json` is missing or not an asset list names none.
 * Throws when the workspace folder or its assets cannot be read, since that says
 * nothing about which hashes it names, as when its volume is not mounted.
 */
export async function visitRecordedHashes(dataDir: string, visit: (hash: string) => void): Promise<void> {
  await fsp.access(dataDir);
  let posts: string[];
  try {
    posts = await fsp.readdir(path.join(dataDir, "assets"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const postId of posts) {
    if (!isPostId(postId)) continue;
    let text: string;
    try {
      text = await fsp.readFile(path.join(dataDir, "assets", postId, META_FILENAME), "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw err;
    }
    let assets: unknown;
    try { assets = (JSON.parse(text) as { assets?: unknown }).assets; } catch { continue; }
    if (!Array.isArray(assets)) continue;
    for (const asset of assets) {
      const hash = (asset as { contentHash?: unknown } | null)?.contentHash;
      if (typeof hash === "string") visit(hash);
    }
  }
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

function writeAssetMeta(metaPath: string, assets: RecordedAsset[]): void {
  // recorded: meta.json holds upload times and dimensions that reconcileAssets cannot rebuild from
  // the files, so it is protected with the assets it describes.
  writeManagedText(metaPath, jsonStoreText("assetMeta", { assets }));
}

