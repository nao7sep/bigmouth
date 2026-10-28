/** Registered image hashes and their derivative cache. */
import fsp from "node:fs/promises";
import path from "node:path";
import type { ImageDerivativeKind } from "@shared/ipc";
import { visitRecordedHashes } from "./core/services/assetStore.js";
import { info as logInfo, warn as logWarn, serializeError } from "./core/services/logger.js";
import { generateDerivatives, derivativeName, parseDerivativeName, isContentHash, DERIVATIVE_VERSION } from "./imageGeneration.js";
export { DERIVATIVE_VERSION, DISPLAY_EDGE, THUMB_EDGE, WEBP_QUALITY, derivativeName, parseDerivativeName, isContentHash, generateDerivatives, readImageFacts, imageFacts } from "./imageGeneration.js";
export type { DerivativeOutcome, ImageFacts } from "./imageGeneration.js";
export type { ImageDerivativeKind } from "@shared/ipc";
const TEMPORARY_NAME = /^[0-9a-f]{64}-v\d+-(?:thumb|display)\.webp\.[0-9a-f-]+\.tmp$/;

// --- The cache ---

/** An asset file whose bytes a listing or an upload recorded under a hash. */
interface Source {
  workspaceId: string;
  filePath: string;
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
 * one queue that makes their derivatives.
 *
 * Only hashes main has seen among the assets it listed or installed for the
 * window are served or generated, each tied to the file that holds those bytes,
 * so the window cannot have an arbitrary file read or decoded by naming a hash.
 * Every command — registering, forgetting, serving, generating and sweeping —
 * takes its turn in the queue, so generation runs one image at a time, whatever
 * the number of images asked for, since each one can take a large share of
 * memory and the CPU (libvips already uses several threads for one image), and a
 * repeated request finds the files the earlier one made. An image that failed,
 * or turned out to be animated, is not tried again this session, so a damaged
 * file is not read at every request; the next launch tries it again.
 */
export class ImageDerivatives {
  private readonly sources = new Map<string, Source>();
  private readonly unavailable = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly dir: string,
    private readonly generate: typeof generateDerivatives = generateDerivatives,
  ) {}

  /** Runs `command` after every command before it. */
  private enqueue<T>(command: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(command);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Records that the asset at `filePath` holds the bytes `hash` names. */
  register(hash: string, workspaceId: string, filePath: string): void {
    if (isContentHash(hash)) void this.enqueue(() => { this.sources.set(hash, { workspaceId, filePath }); });
  }

  /** Stops serving the assets of a workspace that was removed from the registry. */
  forgetWorkspace(workspaceId: string): void {
    void this.enqueue(() => {
      for (const [hash, source] of this.sources) if (source.workspaceId === workspaceId) this.sources.delete(hash);
    });
  }

  /**
   * The cache file to serve for `kind` of `hash`, made first if it is missing,
   * or null when the hash is not a registered asset's or no derivative can be
   * made of it.
   */
  resolve(hash: string, kind: ImageDerivativeKind): Promise<string | null> {
    if (!isContentHash(hash)) return Promise.resolve(null);
    return this.enqueue(async () => {
      if (!this.sources.has(hash)) return null;
      const file = path.join(this.dir, derivativeName(hash, kind));
      if (await isFile(file)) return file;
      return (await this.ensure(hash)) && (await isFile(file)) ? file : null;
    });
  }

  /** Starts making a newly added image's derivatives, so its card has one when it is shown. */
  prepare(hash: string): void {
    void this.enqueue(() => this.ensure(hash));
  }

  /** Whether both derivatives of `hash` exist, making them if needed. Runs in the queue; never rejects. */
  private async ensure(hash: string): Promise<boolean> {
    if (this.unavailable.has(hash)) return false;
    try {
      return await this.generateNow(hash);
    } catch (error: unknown) {
      logWarn("image derivatives could not be made", { hash, error: serializeError(error) });
      return false;
    }
  }

  private async generateNow(hash: string): Promise<boolean> {
    if (await isFile(path.join(this.dir, derivativeName(hash, "display"))) &&
      await isFile(path.join(this.dir, derivativeName(hash, "thumb")))) return true;
    const source = this.sources.get(hash);
    if (!source) return false;
    const outcome = await this.generate(source.filePath, hash, this.dir);
    switch (outcome.kind) {
      case "generated":
        return true;
      case "animated":
        this.unavailable.add(hash);
        return false;
      case "changed":
        // The file was replaced since it was listed: its next listing records
        // the new hash, and the old one names nothing here any more.
        this.sources.delete(hash);
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
   * and not registered this session, those of an older format version, and
   * temporary files an interrupted generation left. It takes its turn in the
   * queue, so nothing is being made meanwhile. Returns how many files it removed.
   */
  sweep(referenced: ReadonlySet<string>): Promise<number> {
    return this.enqueue(async () => {
      let names: string[];
      try {
        names = await fsp.readdir(this.dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw err;
      }
      let removed = 0;
      for (const name of names) {
        const parsed = parseDerivativeName(name);
        if (!parsed && !TEMPORARY_NAME.test(name)) continue;
        if (parsed && parsed.version === DERIVATIVE_VERSION && (referenced.has(parsed.hash) || this.sources.has(parsed.hash))) continue;
        const file = path.join(this.dir, name);
        try {
          if (!(await fsp.lstat(file)).isFile()) continue;
          await fsp.rm(file, { force: true });
          removed += 1;
        } catch (err) {
          logWarn("image derivative could not be removed", { path: file, error: serializeError(err) });
        }
      }
      return removed;
    });
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
  const removed = await cache.sweep(referenced);
  if (removed > 0) logInfo("unused image derivatives removed", { removed });
  return removed;
}
