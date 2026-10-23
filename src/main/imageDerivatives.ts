/**
 * Thumbnails and display images of attached pictures.
 *
 * Why they exist: shown at full size, a post of camera photos would decode tens
 * of megapixels to paint 52 px cards. Each still image gets a 360 px thumbnail
 * for the Assets tab and a 1600 px display image for the Preview (longest edge,
 * WebP quality 75). An animated GIF or WebP keeps its original, streamed,
 * because a resize would drop its animation; other files show their file-type
 * tile. An APNG or an AVIF sequence, which sharp reads as one frame, gets a still
 * rendition of its first frame: rare in posts, and accepted.
 *
 * Correctness comes from the names. A derivative is named by the SHA-256 of the
 * exact bytes it was made from plus the format version below, as
 * `<hash>-v1-thumb.webp`. The generator hashes the very buffer it decodes and
 * writes only when that hash is the one it was asked for, each file under a
 * temporary name renamed into place, so a file under a final name is always a
 * complete rendition of the bytes its name says. The window asks for a
 * derivative by the hash its asset listing recorded, so a changed image is a
 * new address and never a stale picture, and responses can be cached forever.
 *
 * The cache lives in the storage root's `thumbnails` folder (storagePaths),
 * this computer's own and safe to clear: a missing derivative is made again
 * the next time it is asked for. A sweep removes the ones no asset names.
 *
 * Memory is kept low by construction, not by a check before starting
 * (volume-handling-conventions): images are made one at a time, the original
 * is held once, as its compressed bytes, and libvips reads it sequentially
 * (sharp's default) and, for JPEG and WebP, shrinks it while loading, so a
 * large photo is never decoded at full size. What still fails, such as a damaged
 * file or one too large for this computer, is contained: nothing is written,
 * the failure is logged once, the window shows the file-type tile, and the image
 * is tried again in a later session.
 */

import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import type { ImageDerivativeKind } from "@shared/ipc";
import type { Metadata, Sharp, SharpOptions } from "sharp";
import { safeResolveUnder, visitRecordedHashes } from "./core/services/assetStore.js";
import { info as logInfo, warn as logWarn, serializeError } from "./core/services/logger.js";

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
// A derivative's name, a random part and `.tmp`, while it is being written.
const TEMPORARY_NAME = /^[0-9a-f]{64}-v\d+-(?:thumb|display)\.webp\.[0-9a-f-]+\.tmp$/;

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
 * bytes are the ones `expectedHash` names.
 *
 * The file is read into one buffer and hashed, and that same buffer is decoded,
 * so the hash describes exactly what was rendered. A stream into sharp would
 * hold no less: sharp gathers stream input into one buffer before decoding. The
 * display image is made first, with EXIF orientation applied and no metadata
 * carried, and the thumbnail from the display image, so the original is decoded
 * once; `withoutEnlargement` keeps a small picture its own size.
 */
export async function generateDerivatives(sourcePath: string, expectedHash: string, dir: string, workspaceRoot = path.dirname(sourcePath)): Promise<DerivativeOutcome> {
  let display: Buffer;
  let thumb: Buffer;
  try {
    const sharp = await loadSharp();
    // Recheck after loading sharp: the registered path may have changed since
    // listing. Node lacks descriptor-relative resolve-beneath, so a hostile
    // concurrent replacement between this check and open is still possible.
    safeResolveUnder(workspaceRoot, path.relative(workspaceRoot, sourcePath));
    const original = await fsp.readFile(sourcePath);
    const actual = createHash("sha256").update(original).digest("hex");
    if (actual !== expectedHash) return { kind: "changed", actual };
    const image = sharp(original);
    const facts = imageFacts(await image.metadata());
    if (!facts) throw new Error("The image header gives no dimensions.");
    if (facts.animated) return { kind: "animated" };
    display = await image
      .rotate()
      .resize({ width: DISPLAY_EDGE, height: DISPLAY_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    thumb = await sharp(display)
      .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
  } catch (error) {
    return { kind: "failed", error };
  }
  try {
    await fsp.mkdir(dir, { recursive: true });
    await writeInPlace(dir, derivativeName(expectedHash, "display"), display);
    await writeInPlace(dir, derivativeName(expectedHash, "thumb"), thumb);
  } catch (error) {
    return { kind: "failed", error };
  }
  return { kind: "generated" };
}

/** Writes `data` under a temporary name in `dir` and renames it to `name`, so the final name only ever holds a whole file. */
async function writeInPlace(dir: string, name: string, data: Buffer): Promise<void> {
  const temporary = path.join(dir, `${name}.${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temporary, data, { flag: "wx" });
    await fsp.rename(temporary, path.join(dir, name));
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

// --- The cache ---

/** An asset file whose bytes a listing or an upload recorded under a hash. */
interface Source {
  workspaceId: string;
  filePath: string;
  workspaceRoot: string;
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fsp.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * The derivative cache of this process: which hashes may be asked for, and the
 * queue that makes their derivatives.
 *
 * Only hashes main has seen among the assets it listed or installed for the
 * window are served or generated, each tied to the file that holds those bytes,
 * so the window cannot have an arbitrary file read or decoded by naming a hash.
 * Generation runs one image at a time, whatever the number of images asked for,
 * since each one can take a large share of memory and the CPU (libvips already
 * uses several threads for one image). An image that failed, or turned out to be
 * animated, is not tried again this session, so a damaged file is not read at
 * every request; the next launch tries it again.
 */
export class ImageDerivatives {
  private readonly sources = new Map<string, Source>();
  private readonly unavailable = new Set<string>();
  private readonly pending = new Map<string, Promise<boolean>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly dir: string,
    private readonly generate: typeof generateDerivatives = generateDerivatives,
  ) {}

  /** Records that the asset at `filePath` holds the bytes `hash` names. */
  register(hash: string, workspaceId: string, filePath: string, workspaceRoot: string): void {
    if (isContentHash(hash)) this.sources.set(hash, { workspaceId, filePath, workspaceRoot });
  }

  /** Stops serving the assets of a workspace that was removed from the registry. */
  forgetWorkspace(workspaceId: string): void {
    for (const [hash, source] of this.sources) if (source.workspaceId === workspaceId) this.sources.delete(hash);
  }

  isRegistered(hash: string): boolean {
    return this.sources.has(hash);
  }

  /**
   * The cache file to serve for `kind` of `hash`, made first if it is missing,
   * or null when the hash is not a registered asset's or no derivative can be
   * made of it.
   */
  async resolve(hash: string, kind: ImageDerivativeKind): Promise<string | null> {
    if (!isContentHash(hash) || !this.sources.has(hash)) return null;
    const file = path.join(this.dir, derivativeName(hash, kind));
    if (await isFile(file)) return file;
    if (!(await this.ensure(hash))) return null;
    return (await isFile(file)) ? file : null;
  }

  /** Starts making a newly added image's derivatives, so its card has one when it is shown. */
  prepare(hash: string): void {
    void this.ensure(hash);
  }

  /** Whether both derivatives of `hash` exist, making them in turn if needed. Never rejects. */
  private ensure(hash: string): Promise<boolean> {
    if (this.unavailable.has(hash)) return Promise.resolve(false);
    const running = this.pending.get(hash);
    if (running) return running;
    const run = this.queue.then(() => this.generateNow(hash)).catch((error: unknown) => {
      logWarn("image derivatives could not be made", { hash, error: serializeError(error) });
      return false;
    });
    this.queue = run;
    this.pending.set(hash, run);
    void run.finally(() => this.pending.delete(hash));
    return run;
  }

  private async generateNow(hash: string): Promise<boolean> {
    if (await isFile(path.join(this.dir, derivativeName(hash, "display"))) &&
      await isFile(path.join(this.dir, derivativeName(hash, "thumb")))) return true;
    const source = this.sources.get(hash);
    if (!source) return false;
    const outcome = await this.generate(source.filePath, hash, this.dir, source.workspaceRoot);
    switch (outcome.kind) {
      case "generated":
        return true;
      case "animated":
        this.unavailable.add(hash);
        return false;
      case "changed":
        // The file was replaced since it was listed: its next listing records
        // the new hash, and the old one names nothing here any more.
        if (this.sources.get(hash) === source) this.sources.delete(hash);
        logInfo("image changed before its derivatives were made", { path: source.filePath });
        return false;
      case "failed":
        this.unavailable.add(hash);
        logWarn("image derivatives could not be made; its file tile is shown", {
          path: source.filePath,
          error: serializeError(outcome.error),
        });
        return false;
    }
  }

  /**
   * Removes the derivatives no asset names: those of a hash outside `referenced`
   * and not registered this session, and those of an older format version. A
   * file written since `startedAt` is kept, so one made during the sweep stays,
   * and so is a temporary file this launch may still be writing. Returns how
   * many files it removed.
   */
  async sweep(referenced: ReadonlySet<string>, startedAt: number): Promise<number> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw err;
    }
    const launchedAt = Date.now() - process.uptime() * 1000;
    let removed = 0;
    for (const name of names) {
      const parsed = parseDerivativeName(name);
      const temporary = TEMPORARY_NAME.test(name);
      if (!parsed && !temporary) continue;
      if (parsed && parsed.version === DERIVATIVE_VERSION && (referenced.has(parsed.hash) || this.sources.has(parsed.hash))) continue;
      const file = path.join(this.dir, name);
      try {
        const stat = await fsp.lstat(file);
        if (!stat.isFile() || stat.mtimeMs >= (temporary ? launchedAt : startedAt)) continue;
        await fsp.rm(file, { force: true });
        removed += 1;
      } catch (err) {
        logWarn("image derivative could not be removed", { path: file, error: serializeError(err) });
      }
    }
    return removed;
  }
}

// --- This process's cache ---

let current: ImageDerivatives | null = null;

/** Sets up the cache in `dir`, the storage root's thumbnails folder; called once at startup. */
export function configureImageDerivatives(dir: string): ImageDerivatives {
  current = new ImageDerivatives(dir);
  return current;
}

/** The cache, or null before startup has set it up. */
export function imageDerivatives(): ImageDerivatives | null {
  return current;
}

/**
 * Collects the hashes every registered workspace's assets record and sweeps the
 * cache against them. When a workspace cannot be read, as when its volume is
 * not mounted, nothing is removed: what it names is unknown.
 */
export async function sweepImageDerivatives(
  cache: ImageDerivatives,
  workspaces: readonly { dataDirectory: string }[],
): Promise<number> {
  const startedAt = Date.now();
  const referenced = new Set<string>();
  for (const workspace of workspaces) {
    try {
      await visitRecordedHashes(workspace.dataDirectory, (hash) => referenced.add(hash));
    } catch (error) {
      logInfo("image derivatives not swept: a workspace could not be read", {
        dataDirectory: workspace.dataDirectory,
        error: serializeError(error),
      });
      return 0;
    }
  }
  const removed = await cache.sweep(referenced, startedAt);
  if (removed > 0) logInfo("unused image derivatives removed", { removed });
  return removed;
}
