import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { ImageDerivativeKind } from "@shared/ipc";
import type { Metadata, Sharp, SharpOptions } from "sharp";

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

type SharpFactory = (input?: Buffer | string, options?: SharpOptions) => Sharp;
let loadedSharp: Promise<SharpFactory> | null = null;

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
    return sharp as unknown as SharpFactory;
  });
  loadedSharp.catch(() => { loadedSharp = null; });
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
 * Makes both derivatives of the image at `sourcePath` in `dir`, provided its
 * bytes are the ones `expectedHash` names. The file is hashed through bounded
 * chunks, then sharp decodes it by path, since sharp gathers stream input into
 * memory. The display image is made first, with EXIF orientation applied and no
 * metadata carried, and the thumbnail from the display file, so the original is
 * decoded once; `withoutEnlargement` keeps a small picture its own size. Each
 * rendition is written under a temporary name and renamed into place.
 */
export async function generateDerivatives(
  sourcePath: string,
  expectedHash: string,
  dir: string,
): Promise<DerivativeOutcome> {
  const display = path.join(dir, `${derivativeName(expectedHash, "display")}.${randomUUID()}.tmp`);
  const thumb = path.join(dir, `${derivativeName(expectedHash, "thumb")}.${randomUUID()}.tmp`);
  try {
    const sharp = await loadSharp();
    const actual = await hashFile(sourcePath);
    if (actual !== expectedHash) return { kind: "changed", actual };
    const image = sharp(sourcePath);
    const facts = imageFacts(await image.metadata());
    if (!facts) throw new Error("The image header gives no dimensions.");
    if (facts.animated) return { kind: "animated" };
    await fsp.mkdir(dir, { recursive: true });
    await image.rotate()
      .resize({ width: DISPLAY_EDGE, height: DISPLAY_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toFile(display);
    await sharp(display)
      .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toFile(thumb);
    await fsp.rename(display, path.join(dir, derivativeName(expectedHash, "display")));
    await fsp.rename(thumb, path.join(dir, derivativeName(expectedHash, "thumb")));
    return { kind: "generated" };
  } catch (error) {
    return { kind: "failed", error };
  } finally {
    await Promise.allSettled([fsp.rm(display, { force: true }), fsp.rm(thumb, { force: true })]);
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath, { highWaterMark: 64 * 1024 })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
