import type { FileHandle } from "node:fs/promises";
import fsp from "node:fs/promises";
import path from "node:path";

import { ipcMain } from "electron";
import exifr from "exifr";

import type { AssetMeta } from "@shared/types";
import {
  CHANNELS,
  type AssetDeleteResult,
  type AssetUploadFromMain,
  type AssetUploadResult,
  type AssetUploadStart,
} from "@shared/ipc";
import { isImageAssetFilename, isReservedAssetName } from "@shared/assetNames";
import { carriedMessage, carryingText } from "@shared/i18n/carriedMessage";
import { utcNow, formatUtcIso } from "../core/shared/timestamps.js";
import { getPost } from "../storageAccess.js";
import {
  assetPath,
  sanitizeFilename,
  stagingDir,
} from "../core/services/assetStore.js";
import { info as logInfo, warn as logWarn, error as logError, serializeError } from "../core/services/logger.js";
import { resolveWorkspace } from "./context.js";
import { listAssets, installAsset, deleteAsset, readSourceMetadata, fileExists } from "../storageAccess.js";
import { isPostId } from "../core/shared/filenames.js";
import { receiveUpload, type UploadPort } from "../assetUpload.js";
import { imageDerivatives, readImageFacts } from "../imageDerivatives.js";

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

/** The renderer is an untrusted IPC peer: an upload's start is checked field by field. */
function readUploadStart(raw: unknown): AssetUploadStart {
  const start = (raw !== null && typeof raw === "object" ? raw : {}) as Partial<Record<keyof AssetUploadStart, unknown>>;
  if (typeof start.wsId !== "string") throw new Error("Invalid workspace id");
  if (typeof start.name !== "string" || !start.name) throw new Error("No file provided");
  const postId = readPostId(start.postId);
  if (!postId) throw new Error("Invalid postId");
  return {
    wsId: start.wsId,
    postId,
    name: start.name,
    ...(typeof start.sourcePath === "string" && { sourcePath: start.sourcePath }),
  };
}

// exifr 7.1.3, its latest release, sizes a file it opens by path with
// `handle.stat(path)`, which current Node rejects because it takes options
// there, so every read by path throws and leaves the handle open. This reader
// opens and sizes the file as Node expects; carriesMetadata closes it.
type ExifrFsReader = { input: string; fh?: FileHandle; size?: number };
const BrokenFsReader = exifr.fileReaders.get("fs") as new (...args: never[]) => ExifrFsReader;
class FsReader extends BrokenFsReader {
  async open(): Promise<void> {
    if (this.fh !== undefined) return;
    this.fh = await fsp.open(this.input, "r");
    this.size = (await this.fh.stat()).size;
  }
}
exifr.fileReaders.set("fs", FsReader);

type ExifrReading = { read(input: string): Promise<void>; parse(): Promise<unknown>; file?: { close?(): Promise<void> } };
const Exifr = (exifr as unknown as { Exifr: new (options: object) => ExifrReading }).Exifr;

/**
 * Whether an image carries EXIF, IPTC or XMP metadata. exifr reads the staged
 * file by path, in a few chunks, so a large image is never read whole. A PNG's
 * IHDR header is not metadata, so it is not asked for.
 */
async function carriesMetadata(filePath: string): Promise<boolean> {
  const reading = new Exifr({ ihdr: false, xmp: true, iptc: true });
  try {
    await reading.read(filePath);
    const found = await reading.parse();
    return found !== null && typeof found === "object" && Object.keys(found).length > 0;
  } catch {
    // Not a format exifr recognises.
    return false;
  } finally {
    try { await reading.file?.close?.(); } catch { /* Nothing was written; the handle is let go. */ }
  }
}

/**
 * Lets the window ask for the thumbnail and display image of a listed or added
 * image by its hash (see imageDerivatives). Returns the hash it registered.
 */
function registerImage(wsId: string, dir: string, postId: string, asset: AssetMeta): string | null {
  const cache = imageDerivatives();
  if (!cache || !asset.contentHash || !isImageAssetFilename(asset.filename)) return null;
  try {
    cache.register(asset.contentHash, wsId, assetPath(dir, postId, asset.filename), dir);
    return asset.contentHash;
  } catch {
    return null;
  }
}

/**
 * One upload, from its start message to its result. Refusals that need no bytes
 * are answered before any are sent. Whatever happens after the bytes are staged,
 * the staged file is removed once the upload settles; an installed one has
 * already been renamed away.
 */
async function upload(port: UploadPort, raw: unknown): Promise<AssetUploadResult | null> {
  const start = readUploadStart(raw);
  const { wsId, postId } = start;
  const dir = (await resolveWorkspace(wsId)).dataDirectory;
  const filename = sanitizeFilename(start.name);
  if (isReservedAssetName(filename)) return { ok: false, admission: { code: "reserved-name", filename } };
  const post = await getPost(dir, postId);
  if (!post) return { ok: false, admission: { code: "post-missing" } };
  if (post.frontMatter.locked === true) return { ok: false, admission: { code: "post-locked" } };

  const received = await receiveUpload(port, stagingDir(dir));
  switch (received.kind) {
    case "abandoned":
      logWarn("asset upload abandoned", { workspace: wsId, postId, filename });
      return null;
    case "source-unreadable":
      logWarn("asset upload stopped: the renderer could not read the file", { workspace: wsId, postId, filename });
      return { ok: false, failure: { code: "source-unreadable" } };
    case "write-failed":
      logError("asset upload could not be staged", { workspace: wsId, postId, filename, problem: received.problem, error: serializeError(received.error) });
      return { ok: false, failure: { code: "workspace-unwritable", problem: received.problem } };
  }

  const { staging, staged } = received;
  try {
    const image = isImageAssetFilename(filename);
    const hasMetadata = image && (await carriesMetadata(staging.path));
    // Its dimensions and frame count come from the image's header, read by sharp
    // without decoding the picture; a file sharp cannot read records neither.
    const facts = image ? await readImageFacts(staging.path) : null;
    const meta = {
      filename,
      size: staged.size,
      ...(facts && { width: facts.width, height: facts.height, animated: facts.animated }),
      ...(hasMetadata && { hasMetadata }),
      uploadedAt: formatUtcIso(utcNow()),
    };
    // The post's lock is checked again at publication, inside the storage task.
    const result = await installAsset(dir, postId, filename, staged, meta, await readSourceMetadata(start.sourcePath, staged.size));
    if (result.ok) {
      logInfo("asset uploaded", { workspace: wsId, postId, filename: result.asset.filename, size: staged.size, hasMetadata });
      // Its thumbnail and display image are made now, in the background, so the
      // card that shows it next already has one.
      const hash = registerImage(wsId, dir, postId, result.asset);
      if (hash && result.asset.animated !== true) imageDerivatives()?.prepare(hash);
    }
    return result;
  } finally {
    await staging.discard();
  }
}

/**
 * Answers an upload on its port, once. An unexpected failure is logged here and
 * reaches the renderer only as fixed text, or as the catalogue message the
 * failure carries (error-handling-conventions).
 */
export async function handleUpload(port: UploadPort & { close(): void }, raw: unknown): Promise<void> {
  let reply: AssetUploadFromMain | null;
  try {
    const result = await upload(port, raw);
    reply = result && { type: "result", result };
  } catch (err) {
    const { wsId, postId } = (raw !== null && typeof raw === "object" ? raw : {}) as { wsId?: unknown; postId?: unknown };
    logError("asset upload failed", { workspace: String(wsId), postId: String(postId), error: serializeError(err) });
    const carried = carriedMessage(err);
    reply = { type: "failed", message: carried ? carryingText(carried) : "The file could not be added." };
  }
  try {
    if (reply) port.postMessage(reply);
  } catch {
    // The window went away; nobody is waiting for the answer.
  } finally {
    port.close();
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
    for (const asset of listing.assets) registerImage(wsId, dir, pid, asset);
    logInfo("assets listed", { workspace: wsId, postId: pid, count: listing.assets.length });
    return listing;
  });

  // An upload arrives as a start message with a port, and its bytes follow on the
  // port (see handleUpload); `invoke` cannot carry a port.
  ipcMain.on(CHANNELS.uploadAsset, (event, start: unknown) => {
    const [port] = event.ports;
    if (!port) return;
    void handleUpload(port, start);
  });

  ipcMain.handle(CHANNELS.deleteAsset, async (_event, wsId: string, postId: string, filename: string) => {
    const dir = (await resolveWorkspace(wsId)).dataDirectory;
    const pid = readPostId(postId);
    const fn = readFilename(filename);
    if (!pid || !fn) throw new Error("Invalid postId or filename");

    let filePath: string;
    try {
      filePath = assetPath(dir, pid, fn);
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

    let result: AssetDeleteResult;
    try {
      result = await deleteAsset(dir, pid, fn);
    } catch (err) {
      logError("asset metadata update failed", { workspace: wsId, postId: pid, filename: fn, error: serializeError(err) });
      throw new Error(assetStoreErrorMessage(err));
    }
    logInfo("asset deleted", { workspace: wsId, postId: pid, filename: fn });
    return result;
  });
}
