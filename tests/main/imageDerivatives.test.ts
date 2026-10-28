// Covers image derivatives: their names and format version, generation that
// writes both files whole and only for the bytes it was asked about, what an
// animated, changed or damaged image gets (nothing), the one-at-a-time queue,
// session memory of failures, the refusal of unknown hashes, and the sweep.
// Images are made by sharp in each test; no fixtures are kept.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";

vi.mock("@main/core/services/logger.js", () => ({
  debug: () => {},
  info: vi.fn(),
  warn: vi.fn(),
  error: () => {},
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));

import {
  DERIVATIVE_VERSION,
  DISPLAY_EDGE,
  ImageDerivatives,
  THUMB_EDGE,
  derivativeName,
  generateDerivatives,
  parseDerivativeName,
  readImageFacts,
  sweepImageDerivatives,
  type DerivativeOutcome,
} from "@main/imageDerivatives.js";
import { warn } from "@main/core/services/logger.js";

let root: string;
let thumbnails: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-derivatives-"));
  thumbnails = path.join(root, "thumbnails");
  vi.mocked(warn).mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function write(name: string, bytes: Buffer): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function photo(width = 3000, height = 2000): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#cc6633" } })
    .jpeg()
    .withExif({ IFD0: { Make: "Camera", Model: "Secret" } })
    .toBuffer();
}

/** A two-frame animation: frames stacked vertically, each `pageHeight` tall. */
function animation(format: "gif" | "webp"): Promise<Buffer> {
  const [width, height] = [8, 6];
  // Two different frames: an encoder merges identical ones into one.
  const pixels = Buffer.alloc(width * height * 2 * 4, 255);
  pixels.fill(0, 0, width * height * 4);
  return sharp(pixels, { raw: { width, height: height * 2, channels: 4, pageHeight: height } })[format]().toBuffer();
}

const cacheFiles = () => (fs.existsSync(thumbnails) ? fs.readdirSync(thumbnails).sort() : []);

describe("derivative names", () => {
  const hash = "0".repeat(64);

  it("name the bytes' hash, the format version and the kind", () => {
    expect(derivativeName(hash, "thumb")).toBe(`${hash}-v${DERIVATIVE_VERSION}-thumb.webp`);
    expect(derivativeName(hash, "display")).toBe(`${hash}-v${DERIVATIVE_VERSION}-display.webp`);
  });

  it("read back what they name, and nothing else", () => {
    expect(parseDerivativeName(derivativeName(hash, "display"))).toEqual({ hash, version: DERIVATIVE_VERSION, kind: "display" });
    expect(parseDerivativeName(`${hash}-v7-thumb.webp`)).toEqual({ hash, version: 7, kind: "thumb" });
    expect(parseDerivativeName(`${hash}-v1-poster.webp`)).toBeNull();
    expect(parseDerivativeName("notes.txt")).toBeNull();
  });
});

describe("readImageFacts", () => {
  it("gives the size as shown, after EXIF orientation", async () => {
    const sideways = await sharp({ create: { width: 300, height: 100, channels: 3, background: "#000" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect(await readImageFacts(write("sideways.jpg", sideways))).toEqual({ width: 100, height: 300, animated: false });
  });

  it("tells an animation by its frames", async () => {
    expect(await readImageFacts(write("moving.gif", await animation("gif")))).toEqual({ width: 8, height: 6, animated: true });
  });

  it("is null for a file that is not an image", async () => {
    expect(await readImageFacts(write("fake.png", Buffer.from("not an image")))).toBeNull();
  });
});

describe("generateDerivatives", () => {
  it("writes a display image and a thumbnail of the bytes it was asked about, without their metadata", async () => {
    const bytes = await photo(6000, 4000);
    const outcome = await generateDerivatives(write("photo.jpg", bytes), sha(bytes), thumbnails);
    expect(outcome).toEqual({ kind: "generated" });
    const hash = sha(bytes);
    expect(cacheFiles()).toEqual([derivativeName(hash, "display"), derivativeName(hash, "thumb")]);

    const display = await sharp(path.join(thumbnails, derivativeName(hash, "display"))).metadata();
    expect([display.format, display.width, display.height]).toEqual(["webp", DISPLAY_EDGE, 1067]);
    expect(display.exif).toBeUndefined();
    const thumb = await sharp(path.join(thumbnails, derivativeName(hash, "thumb"))).metadata();
    expect([thumb.format, thumb.width, thumb.height]).toEqual(["webp", THUMB_EDGE, 240]);
  });

  it("never enlarges a small image", async () => {
    const bytes = await photo(200, 100);
    await generateDerivatives(write("small.jpg", bytes), sha(bytes), thumbnails);
    const display = await sharp(path.join(thumbnails, derivativeName(sha(bytes), "display"))).metadata();
    expect([display.width, display.height]).toEqual([200, 100]);
  });

  it("writes each file under a temporary name in the cache folder and renames it into place", async () => {
    const bytes = await photo(400, 300);
    const rename = fsp.rename;
    const renames = vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      expect(String(from)).toMatch(/\.tmp$/);
      expect(path.dirname(String(from))).toBe(thumbnails);
      expect((await sharp(String(from)).metadata()).format).toBe("webp");
      await rename(from, to);
    });
    try {
      expect(await generateDerivatives(write("photo.jpg", bytes), sha(bytes), thumbnails)).toEqual({ kind: "generated" });
      expect(renames.mock.calls.map(([, to]) => path.basename(String(to)))).toEqual([
        derivativeName(sha(bytes), "display"), derivativeName(sha(bytes), "thumb"),
      ]);
    } finally { renames.mockRestore(); }
  });

  it("hashes the source by streaming it, without reading the whole file into a buffer", async () => {
    const bytes = await photo(6000, 4000);
    const source = write("large.jpg", bytes);
    const read = vi.spyOn(fsp, "readFile");
    try {
      expect(await generateDerivatives(source, sha(bytes), thumbnails)).toEqual({ kind: "generated" });
      expect(read.mock.calls.some(([file]) => String(file) === source)).toBe(false);
    } finally {
      read.mockRestore();
    }
  });

  it("leaves no partial file when a write fails", async () => {
    const bytes = await photo(400, 300);
    const rename = vi.spyOn(fsp, "rename");
    rename.mockImplementationOnce(async (from, to) => fs.renameSync(from, to));
    rename.mockRejectedValueOnce(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
    try {
      const outcome = await generateDerivatives(write("photo.jpg", bytes), sha(bytes), thumbnails);
      expect(outcome.kind).toBe("failed");
    } finally { rename.mockRestore(); }
    // The display image is whole; the thumbnail never got its name, and its temporary file is gone.
    expect(cacheFiles()).toEqual([derivativeName(sha(bytes), "display")]);
  });

  it("writes nothing when the file's bytes are no longer the ones asked about", async () => {
    const before = await photo(400, 300);
    const after = await photo(500, 300);
    const outcome = await generateDerivatives(write("photo.jpg", after), sha(before), thumbnails);
    expect(outcome).toEqual({ kind: "changed", actual: sha(after) });
    expect(cacheFiles()).toEqual([]);
  });

  it.each(["gif", "webp"] as const)("makes nothing of an animated %s", async (format) => {
    const bytes = await animation(format);
    expect(await generateDerivatives(write(`moving.${format}`, bytes), sha(bytes), thumbnails)).toEqual({ kind: "animated" });
    expect(cacheFiles()).toEqual([]);
  });

  it("makes nothing of a damaged image and says why", async () => {
    const whole = await photo(400, 300);
    const damaged = whole.subarray(0, 600);
    const outcome = await generateDerivatives(write("damaged.jpg", damaged), sha(damaged), thumbnails);
    expect(outcome.kind).toBe("failed");
    expect(cacheFiles()).toEqual([]);
  });
});

/** A generator the test settles by hand, recording how many run at once. */
function controlledGenerator() {
  const runs: { hash: string; settle: (outcome: DerivativeOutcome) => void }[] = [];
  let running = 0;
  let mostAtOnce = 0;
  const waiting: (() => void)[] = [];
  const generate = vi.fn((_source: string, hash: string, dir: string) => {
    running += 1;
    mostAtOnce = Math.max(mostAtOnce, running);
    return new Promise<DerivativeOutcome>((resolve) => {
      for (const wake of waiting.splice(0)) wake();
      runs.push({
        hash,
        settle: (outcome) => {
          if (outcome.kind === "generated") {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, derivativeName(hash, "thumb")), "t");
            fs.writeFileSync(path.join(dir, derivativeName(hash, "display")), "d");
          }
          running -= 1;
          resolve(outcome);
        },
      });
    });
  });
  /** Resolves once `count` generations have started, checking those already started first. */
  const started = async (count: number) => {
    while (runs.length < count) await new Promise<void>((resolve) => { waiting.push(resolve); });
  };
  return { generate, runs, started, mostAtOnce: () => mostAtOnce };
}

describe("ImageDerivatives", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const c = "c".repeat(64);

  it("refuses a hash no listed asset has, and never generates for it", async () => {
    const { generate } = controlledGenerator();
    const cache = new ImageDerivatives(thumbnails, generate);
    expect(await cache.resolve(a, "thumb")).toBeNull();
    expect(await cache.resolve("../../etc/passwd", "thumb")).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it("serves an existing derivative of a registered hash without generating", async () => {
    const { generate } = controlledGenerator();
    const cache = new ImageDerivatives(thumbnails, generate);
    fs.mkdirSync(thumbnails);
    fs.writeFileSync(path.join(thumbnails, derivativeName(a, "thumb")), "t");
    cache.register(a, "ws", path.join(root, "a.png"));
    expect(await cache.resolve(a, "thumb")).toBe(path.join(thumbnails, derivativeName(a, "thumb")));
    expect(generate).not.toHaveBeenCalled();
  });

  it("makes one image at a time, however many are asked for, and each once", async () => {
    const { generate, runs, started, mostAtOnce } = controlledGenerator();
    const cache = new ImageDerivatives(thumbnails, generate);
    for (const hash of [a, b, c]) cache.register(hash, "ws", path.join(root, `${hash}.png`));

    const asked = [cache.resolve(a, "thumb"), cache.resolve(a, "display"), cache.resolve(b, "thumb"), cache.resolve(c, "display")];
    await started(1);
    runs[0].settle({ kind: "generated" });
    await started(2);
    runs[1].settle({ kind: "generated" });
    await started(3);
    runs[2].settle({ kind: "generated" });

    const served = await Promise.all(asked);
    expect(served.map((file) => file && path.basename(file))).toEqual([
      derivativeName(a, "thumb"),
      derivativeName(a, "display"),
      derivativeName(b, "thumb"),
      derivativeName(c, "display"),
    ]);
    // Requests take their turns in order, and a repeated one finds the files.
    expect(runs.map((run) => run.hash)).toEqual([a, b, c]);
    expect(mostAtOnce()).toBe(1);
  });

  it("does not try a failed image again this session, and logs it once", async () => {
    const { generate, runs, started } = controlledGenerator();
    const cache = new ImageDerivatives(thumbnails, generate);
    cache.register(a, "ws", path.join(root, "a.png"));
    const first = cache.resolve(a, "thumb");
    await started(1);
    runs[0].settle({ kind: "failed", error: new Error("VipsJpeg: premature end of JPEG image") });
    expect(await first).toBeNull();
    expect(await cache.resolve(a, "display")).toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // A later session, a new cache, tries again.
    const later = new ImageDerivatives(thumbnails, generate);
    later.register(a, "ws", path.join(root, "a.png"));
    void later.resolve(a, "thumb");
    await started(2);
  });

  it("serves nothing for an animated image and does not decode it again", async () => {
    const { generate, runs, started } = controlledGenerator();
    const cache = new ImageDerivatives(thumbnails, generate);
    cache.register(a, "ws", path.join(root, "a.gif"));
    const first = cache.resolve(a, "thumb");
    await started(1);
    runs[0].settle({ kind: "animated" });
    expect(await first).toBeNull();
    expect(await cache.resolve(a, "thumb")).toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("forgets a hash whose file changed, until a listing registers it again", async () => {
    const { generate, runs, started } = controlledGenerator();
    const cache = new ImageDerivatives(thumbnails, generate);
    cache.register(a, "ws", path.join(root, "a.png"));
    const first = cache.resolve(a, "thumb");
    await started(1);
    runs[0].settle({ kind: "changed", actual: b });
    expect(await first).toBeNull();
    // Unregistered now: not served even once its derivative exists.
    fs.mkdirSync(thumbnails, { recursive: true });
    fs.writeFileSync(path.join(thumbnails, derivativeName(a, "thumb")), "t");
    expect(await cache.resolve(a, "thumb")).toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("stops serving a removed workspace's images", async () => {
    const cache = new ImageDerivatives(thumbnails, controlledGenerator().generate);
    fs.mkdirSync(thumbnails);
    for (const hash of [a, b]) fs.writeFileSync(path.join(thumbnails, derivativeName(hash, "thumb")), "t");
    cache.register(a, "ws1", path.join(root, "a.png"));
    cache.register(b, "ws2", path.join(root, "b.png"));
    cache.forgetWorkspace("ws1");
    expect(await cache.resolve(a, "thumb")).toBeNull();
    expect(await cache.resolve(b, "thumb")).toBe(path.join(thumbnails, derivativeName(b, "thumb")));
  });

  it("generates the real derivatives of a registered image", async () => {
    const bytes = await photo(800, 600);
    const cache = new ImageDerivatives(thumbnails);
    cache.register(sha(bytes), "ws", write("photo.jpg", bytes));
    const file = await cache.resolve(sha(bytes), "thumb");
    expect((await sharp(file!).metadata()).width).toBe(THUMB_EDGE);
  });

  it.skipIf(process.platform === "win32")("generates the derivatives of an image reached through a link", async () => {
    const bytes = await photo(80, 60);
    const shared = write("shared.jpg", bytes);
    const assets = path.join(root, "assets", "post1");
    fs.mkdirSync(assets, { recursive: true });
    const source = path.join(assets, "linked.jpg");
    fs.symlinkSync(shared, source);
    const cache = new ImageDerivatives(thumbnails);
    cache.register(sha(bytes), "ws", source);
    expect(await cache.resolve(sha(bytes), "thumb")).toBe(path.join(thumbnails, derivativeName(sha(bytes), "thumb")));
  });

  it("refuses a damaged image with no derivative and does not read it again", async () => {
    const damaged = Buffer.from("this is not a picture");
    const file = write("damaged.png", damaged);
    const generate = vi.fn(generateDerivatives);
    const cache = new ImageDerivatives(thumbnails, generate);
    cache.register(sha(damaged), "ws", file);
    expect(await cache.resolve(sha(damaged), "thumb")).toBeNull();
    expect(await cache.resolve(sha(damaged), "display")).toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(cacheFiles()).toEqual([]);
  });
});

describe("sweeping the cache", () => {
  const kept = "1".repeat(64);
  const registered = "2".repeat(64);
  const unused = "3".repeat(64);
  function cacheFile(name: string): void {
    fs.mkdirSync(thumbnails, { recursive: true });
    fs.writeFileSync(path.join(thumbnails, name), "x");
  }

  it("removes derivatives no asset names, older formats and leftover temporary files, and keeps the rest", async () => {
    const cache = new ImageDerivatives(thumbnails, controlledGenerator().generate);
    cache.register(registered, "ws", path.join(root, "r.png"));
    for (const hash of [kept, registered, unused]) {
      cacheFile(derivativeName(hash, "thumb"));
      cacheFile(derivativeName(hash, "display"));
    }
    cacheFile(`${kept}-v0-thumb.webp`);
    cacheFile(`${unused}-v1-thumb.webp.0f8e-4c.tmp`);
    cacheFile("someone-elses-file.txt");

    expect(await cache.sweep(new Set([kept]))).toBe(4);
    expect(cacheFiles()).toEqual([
      derivativeName(kept, "display"),
      derivativeName(kept, "thumb"),
      derivativeName(registered, "display"),
      derivativeName(registered, "thumb"),
      "someone-elses-file.txt",
    ].sort());
  });

  it("does nothing without a cache folder", async () => {
    expect(await new ImageDerivatives(thumbnails).sweep(new Set())).toBe(0);
  });

  function workspaceWith(name: string, records: Record<string, unknown[]>): string {
    const dataDirectory = path.join(root, name);
    for (const [postId, assets] of Object.entries(records)) {
      fs.mkdirSync(path.join(dataDirectory, "assets", postId), { recursive: true });
      fs.writeFileSync(path.join(dataDirectory, "assets", postId, "meta.json"), JSON.stringify({ formatVersion: 2, assets }));
    }
    fs.mkdirSync(dataDirectory, { recursive: true });
    return dataDirectory;
  }

  it("keeps what any registered workspace's meta.json records", async () => {
    const one = workspaceWith("one", { postA: [{ filename: "a.png", size: 1, contentHash: kept }] });
    const two = workspaceWith("two", { postB: [{ filename: "b.png", size: 1, contentHash: registered }, { filename: "c.txt", size: 1 }] });
    cacheFile(derivativeName(kept, "thumb"));
    cacheFile(derivativeName(registered, "thumb"));
    cacheFile(derivativeName(unused, "thumb"));
    const cache = new ImageDerivatives(thumbnails, controlledGenerator().generate);
    expect(await sweepImageDerivatives(cache, [{ dataDirectory: one }, { dataDirectory: two }])).toBe(1);
    expect(cacheFiles()).toEqual([derivativeName(kept, "thumb"), derivativeName(registered, "thumb")].sort());
  });

  it("removes nothing when a workspace cannot be read, as when its volume is not mounted", async () => {
    const one = workspaceWith("one", {});
    cacheFile(derivativeName(unused, "thumb"));
    const cache = new ImageDerivatives(thumbnails, controlledGenerator().generate);
    expect(await sweepImageDerivatives(cache, [{ dataDirectory: one }, { dataDirectory: path.join(root, "unmounted") }])).toBe(0);
    expect(cacheFiles()).toEqual([derivativeName(unused, "thumb")]);
  });
});
