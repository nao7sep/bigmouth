import { createHash, randomUUID } from "node:crypto";
import fsp, { type FileHandle } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";

import type { ImageDerivativeKind } from "@shared/ipc";
import type { Metadata, Sharp, SharpOptions } from "sharp";
import { safeResolveUnder } from "./core/services/assetStore.js";

export type { ImageDerivativeKind } from "@shared/ipc";

/** Engineering bound. Longest edges: a thumbnail sharp on a 2× grid card, a display image on a HiDPI pane. */
export const THUMB_EDGE = 360;
export const DISPLAY_EDGE = 1600;
/** Engineering bound. WebP quality: indistinguishable at these sizes, a fraction of the bytes. */
export const WEBP_QUALITY = 75;
/**
 * The derivatives' format, part of every name. Raise it when sizes, quality or
 * processing change: older files are then never served and the sweep removes them.
 */
export const DERIVATIVE_VERSION = 1;

const CONTENT_HASH = /^[0-9a-f]{64}$/;
const DERIVATIVE_NAME = /^([0-9a-f]{64})-v(\d+)-(thumb|display)\.webp$/;

export function isContentHash(value: unknown): value is string {
  return typeof value === "string" && CONTENT_HASH.test(value);
}

/** The cache file of one rendition of the bytes `hash` names. */
export function derivativeName(hash: string, kind: ImageDerivativeKind): string {
  return `${hash}-v${DERIVATIVE_VERSION}-${kind}.webp`;
}

/** What a cache file's name says, or null for a name this module never writes. */
export function parseDerivativeName(name: string): { hash: string; version: number; kind: ImageDerivativeKind } | null {
  const match = DERIVATIVE_NAME.exec(name);
  if (!match) return null;
  return { hash: match[1], version: Number(match[2]), kind: match[3] as ImageDerivativeKind };
}

// --- sharp ---

type SharpFactory = ((input?: Buffer | string, options?: SharpOptions) => Sharp) & { concurrency(threads: number): number };
let loadedSharp: Promise<SharpFactory> | null = null;
let activeSharp: SharpFactory | null = null;
let decoderThreads: number | undefined;

/** The generation worker assigns its share of this host's available decoder threads once. */
export function configureImageConcurrency(threads: number): void {
  decoderThreads = threads;
  activeSharp?.concurrency(threads);
}

/**
 * sharp, loaded on first use rather than at startup: it is a native module, and
 * one that cannot load must cost the thumbnails, not the app. A failed load is
 * contained like any other failure to make an image.
 */
function loadSharp(): Promise<SharpFactory> {
  loadedSharp ??= import("sharp").then(({ default: sharp }) => {
    // libvips' operation cache keeps the decoded pixels of recent inputs alive;
    // every image here is processed once, so the cache would only hold memory.
    sharp.cache(false);
    if (decoderThreads !== undefined) sharp.concurrency(decoderThreads);
    activeSharp = sharp as unknown as SharpFactory;
    return activeSharp;
  });
  loadedSharp.catch(() => { loadedSharp = null; activeSharp = null; });
  return loadedSharp;
}

/** What an image's header says about it, for its asset record. */
export interface ImageFacts {
  width: number;
  height: number;
  animated: boolean;
}

/**
 * Width and height as the image is shown, after its EXIF orientation, and
 * whether it has more than one frame. Read without decoding the picture.
 */
export function imageFacts(meta: Metadata): ImageFacts | null {
  const width = meta.autoOrient?.width ?? meta.width;
  const height = meta.autoOrient?.height ?? meta.height;
  if (!width || !height) return null;
  return { width, height, animated: (meta.pages ?? 1) > 1 };
}

/**
 * The facts of an image file from its header, or null when it is not an image
 * sharp can read. Used at upload, on the staged file, so its record has its
 * dimensions and the window knows whether to show it animated.
 */
export async function readImageFacts(filePath: string): Promise<ImageFacts | null> {
  try {
    const sharp = await loadSharp();
    return imageFacts(await sharp(filePath).metadata());
  } catch {
    return null;
  }
}

export type DerivativeOutcome =
  | { kind: "generated" }
  // More than one frame: no derivative, the original is shown as it is.
  | { kind: "animated" }
  // The file's bytes are no longer the ones asked for; nothing was written.
  | { kind: "changed"; actual: string }
  | { kind: "failed"; error: unknown };

/**
 * Snapshot and hash the source through bounded chunks, then decode that private
 * file. Sharp gathers stream inputs into memory, so it receives a path instead.
 * Both renditions describe the closed snapshot even if the source changes later.
 * Display is rendered once, and the thumbnail reads the bounded display file.
 */
export async function generateDerivatives(
  sourcePath: string,
  expectedHash: string,
  dir: string,
  workspaceRoot = path.dirname(sourcePath),
  stageDirectory?: string,
  progress?: () => void,
  stageCreated?: () => void,
): Promise<DerivativeOutcome> {
  let ownedStage: string | undefined;
  try {
    const sharp = await loadSharp();
    await fsp.mkdir(dir, { recursive: true });
    if (stageDirectory) {
      await fsp.mkdir(path.dirname(stageDirectory), { recursive: true });
      await fsp.mkdir(stageDirectory, { mode: 0o700 });
      ownedStage = stageDirectory;
    } else {
      ownedStage = await fsp.mkdtemp(path.join(dir, ".generate-"));
    }
    stageCreated?.();
    const snapshot = path.join(ownedStage, "source.snapshot");
    const actual = await snapshotSource(sourcePath, workspaceRoot, snapshot, progress);
    progress?.();
    if (actual !== expectedHash) return { kind: "changed", actual };
    const image = sharp(snapshot);
    const facts = imageFacts(await image.metadata());
    progress?.();
    if (!facts) throw new Error("The image header gives no dimensions.");
    if (facts.animated) return { kind: "animated" };
    const display = path.join(ownedStage, `display-${randomUUID()}.tmp`);
    const thumb = path.join(ownedStage, `thumb-${randomUUID()}.tmp`);
    await image.rotate()
      .resize({ width: DISPLAY_EDGE, height: DISPLAY_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toFile(display);
    progress?.();
    await sharp(display)
      .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toFile(thumb);
    progress?.();
    await fsp.rename(display, path.join(dir, derivativeName(expectedHash, "display")));
    await fsp.rename(thumb, path.join(dir, derivativeName(expectedHash, "thumb")));
    return { kind: "generated" };
  } catch (error) {
    return { kind: "failed", error };
  } finally {
    // Every pipeline and native decode/write was awaited before reaching here.
    // Never remove a supplied directory unless this invocation created it.
    if (ownedStage) await fsp.rm(ownedStage, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function snapshotSource(sourcePath: string, workspaceRoot: string, snapshot: string, progress?: () => void): Promise<string> {
  const hash = createHash("sha256");
  let source: FileHandle | undefined;
  const destination = await fsp.open(snapshot, "wx", 0o600);
  try {
    // Node lacks descriptor-relative resolve-beneath: a hostile replacement
    // between this check and open remains possible. The open descriptor pins
    // the chosen source throughout the copy; later decoding uses only our file.
    safeResolveUnder(workspaceRoot, path.relative(workspaceRoot, sourcePath));
    source = await fsp.open(sourcePath, "r");
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        progress?.();
        callback(null, chunk);
      },
    });
    await pipeline(source.createReadStream({ highWaterMark: 64 * 1024 }), hashing, destination.createWriteStream());
    return hash.digest("hex");
  } finally {
    // pipeline closes its FileHandle streams, including on failure. Also close
    // handles acquired before a stream could be connected.
    await Promise.allSettled([source?.close(), destination.close()]);
  }
}
