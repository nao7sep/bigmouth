// Covers the custom asset-scheme handler's request validation and hardening:
// only a well-formed bigmouth-asset://asset/<wsId>/<postId>/<file> for an existing
// workspace + on-disk file yields 200 (with nosniff/sandbox headers); everything
// malformed, traversing, or missing yields 404. Files are streamed, whole or as
// one byte range. Thumbnails and display images are served by content hash, only
// for hashes registered from listed assets. The electron `protocol` is mocked
// to capture the registered handler; the workspace + asset file are real.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { ASSET_SCHEME, assetUrl, imageDerivativeUrl } from "@shared/ipc";

const captured = vi.hoisted(() => ({
  handler: null as null | ((req: Request) => Promise<Response>),
  privileged: null as null | unknown,
}));

vi.mock("@main/storageAccess.js", async () => {
  const workspaceStore = await import("@main/core/services/workspaceStore.js");
  return {
    getWorkspace: async (...args: Parameters<typeof workspaceStore.getWorkspace>) => workspaceStore.getWorkspace(...args),
  };
});

vi.mock("electron", () => ({
  protocol: {
    registerSchemesAsPrivileged: (schemes: unknown) => {
      captured.privileged = schemes;
    },
    handle: (_scheme: string, h: (req: Request) => Promise<Response>) => {
      captured.handler = h;
    },
  },
}));

vi.mock("@main/core/services/logger.js", () => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));

import { registerAssetScheme, handleAssetProtocol, byteRange } from "@main/assetProtocol.js";
import { configureImageDerivatives, derivativeName } from "@main/imageDerivatives.js";
import { initAppDir, createWorkspace } from "@main/core/services/workspaceStore.js";
import { assetDir } from "@main/core/services/assetStore.js";

let home: string;
let wsId: string;
let wsDataDir: string;
const POST_ID = "post1";
const SAVED_HOME = process.env.BIGMOUTH_DATA_DIR;

function serve(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return captured.handler!({ url, headers: new Headers(headers) } as Request);
}

const bytes = async (res: Response) => Buffer.from(await res.arrayBuffer());

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-assetproto-"));
  process.env.BIGMOUTH_DATA_DIR = home;
  initAppDir();
  const ws = createWorkspace("WS");
  wsId = ws.id;
  wsDataDir = ws.dataDirectory;
  // A real asset file under the workspace's per-post asset directory.
  const dir = assetDir(ws.dataDirectory, POST_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pic.png"), Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(path.join(dir, "data.bin"), Buffer.from([9, 9]));
  fs.writeFileSync(path.join(dir, "ten.bin"), Buffer.from("0123456789"));
  fs.writeFileSync(path.join(dir, "empty.bin"), Buffer.alloc(0));
  handleAssetProtocol();
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("registerAssetScheme", () => {
  it("declares the asset scheme privileged", () => {
    registerAssetScheme();
    expect(captured.privileged).toEqual([
      expect.objectContaining({ scheme: ASSET_SCHEME, privileges: expect.objectContaining({ standard: true }) }),
    ]);
  });
});

describe("asset protocol handler", () => {
  it("serves an existing asset with hardening headers and the right MIME", async () => {
    const res = await serve(assetUrl(wsId, POST_ID, "pic.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
    expect(res.headers.get("Content-Length")).toBe("4");
  });

  it("falls back to octet-stream for an unknown extension", async () => {
    const res = await serve(assetUrl(wsId, POST_ID, "data.bin"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  it("404s an unparseable URL", async () => {
    expect((await serve("")).status).toBe(404);
  });

  it("404s a wrong host", async () => {
    expect((await serve(`${ASSET_SCHEME}://other/${wsId}/${POST_ID}/pic.png`)).status).toBe(404);
  });

  it("404s a wrong segment count", async () => {
    expect((await serve(`${ASSET_SCHEME}://asset/${wsId}/${POST_ID}`)).status).toBe(404);
  });

  it("404s a postId with disallowed characters", async () => {
    expect((await serve(assetUrl(wsId, "po.st", "pic.png"))).status).toBe(404);
  });

  it("404s a traversing filename", async () => {
    expect((await serve(assetUrl(wsId, POST_ID, "../secret"))).status).toBe(404);
    expect((await serve(assetUrl(wsId, POST_ID, ".."))).status).toBe(404);
  });

  it("404s an unknown workspace", async () => {
    expect((await serve(assetUrl("no-such-ws", POST_ID, "pic.png"))).status).toBe(404);
  });

  it("404s a file that does not exist", async () => {
    expect((await serve(assetUrl(wsId, POST_ID, "missing.png"))).status).toBe(404);
  });
});

describe("workspace link boundaries", () => {
  it.skipIf(process.platform === "win32")("serves file links, including links leaving the workspace", async () => {
    const dir = assetDir(wsDataDir, POST_ID);
    const contained = path.join(wsDataDir, "shared.png");
    const outside = path.join(home, "outside.png");
    fs.writeFileSync(contained, "inside");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(contained, path.join(dir, "contained.png"));
    fs.symlinkSync(outside, path.join(dir, "outside.png"));
    const response = await serve(assetUrl(wsId, POST_ID, "contained.png"));
    expect(response.status).toBe(200);
    expect(await bytes(response)).toEqual(Buffer.from("inside"));
    const linked = await serve(assetUrl(wsId, POST_ID, "outside.png"));
    expect(linked.status).toBe(200);
    expect(await bytes(linked)).toEqual(Buffer.from("outside"));
  });

  it("serves a post asset directory linked elsewhere inside the workspace", async () => {
    const dir = assetDir(wsDataDir, POST_ID);
    const shared = path.join(wsDataDir, "shared-assets");
    fs.renameSync(dir, shared);
    fs.symlinkSync(shared, dir, process.platform === "win32" ? "junction" : "dir");
    const response = await serve(assetUrl(wsId, POST_ID, "pic.png"));
    expect(response.status).toBe(200);
    expect(await bytes(response)).toEqual(Buffer.from([1, 2, 3, 4]));
  });
});

describe("byteRange", () => {
  it.each([
    [null, { kind: "whole" }],
    ["bytes=2-5", { kind: "part", start: 2, end: 5 }],
    ["bytes=2-", { kind: "part", start: 2, end: 9 }],
    ["bytes=-3", { kind: "part", start: 7, end: 9 }],
    ["bytes=-30", { kind: "part", start: 0, end: 9 }],
    ["bytes=8-99", { kind: "part", start: 8, end: 9 }],
    ["bytes=10-", { kind: "unsatisfiable" }],
    ["bytes=-0", { kind: "unsatisfiable" }],
    // Ignored, as RFC 9110 allows: the whole file is served.
    ["bytes=0-1,4-5", { kind: "whole" }],
    ["bytes=5-2", { kind: "whole" }],
    ["items=0-1", { kind: "whole" }],
    ["bytes=-", { kind: "whole" }],
  ])("reads %s against a 10-byte file", (header, expected) => {
    expect(byteRange(header, 10)).toEqual(expected);
  });

  it("can satisfy no range of an empty file", () => {
    expect(byteRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
    expect(byteRange("bytes=-1", 0)).toEqual({ kind: "unsatisfiable" });
  });
});

describe("streaming an asset", () => {
  it("serves the whole file with 200, its length, and range support", async () => {
    const res = await serve(assetUrl(wsId, POST_ID, "ten.bin"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(res.headers.get("Content-Range")).toBeNull();
    expect((await bytes(res)).toString()).toBe("0123456789");
  });

  it("serves one range with 206 and its Content-Range", async () => {
    const res = await serve(assetUrl(wsId, POST_ID, "ten.bin"), { Range: "bytes=2-5" });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(res.headers.get("Content-Length")).toBe("4");
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await bytes(res)).toString()).toBe("2345");
  });

  it("serves a suffix range", async () => {
    const res = await serve(assetUrl(wsId, POST_ID, "ten.bin"), { Range: "bytes=-3" });
    expect(res.status).toBe(206);
    expect((await bytes(res)).toString()).toBe("789");
  });

  it("answers a range past the end with 416 and the file's size", async () => {
    const res = await serve(assetUrl(wsId, POST_ID, "ten.bin"), { Range: "bytes=10-" });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */10");
  });

  it("serves an empty file with no body", async () => {
    const res = await serve(assetUrl(wsId, POST_ID, "empty.bin"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("0");
    expect((await bytes(res)).length).toBe(0);
  });

  it("ends the body with an error when a read fails partway, without failing the app", async () => {
    const open = vi.spyOn(fsp, "open").mockResolvedValueOnce({
      stat: async () => ({ isFile: () => true, size: 10 }),
      createReadStream: () => new Readable({ read() { this.destroy(Object.assign(new Error("EIO: i/o error"), { code: "EIO" })); } }),
      close: async () => {},
    } as unknown as fsp.FileHandle);
    try {
      const res = await serve(assetUrl(wsId, POST_ID, "ten.bin"));
      expect(res.status).toBe(200);
      await expect(res.arrayBuffer()).rejects.toThrow();
    } finally { open.mockRestore(); }
  });
});

describe("thumbnails and display images", () => {
  let thumbnails: string;
  let photo: Buffer;
  let hash: string;

  beforeEach(async () => {
    thumbnails = path.join(home, "thumbnails");
    photo = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#3366cc" } }).jpeg().toBuffer();
    hash = createHash("sha256").update(photo).digest("hex");
    fs.writeFileSync(path.join(assetDir(wsDataDir, POST_ID), "photo.jpg"), photo);
  });

  it("refuses a hash no listed asset has, without making anything", async () => {
    configureImageDerivatives(thumbnails);
    expect((await serve(imageDerivativeUrl("thumb", hash))).status).toBe(404);
    expect((await serve(imageDerivativeUrl("display", "not-a-hash"))).status).toBe(404);
    expect(fs.existsSync(thumbnails)).toBe(false);
  });

  it("makes a registered image's derivatives on first request and serves them as immutable WebP", async () => {
    const cache = configureImageDerivatives(thumbnails);
    cache.register(hash, wsId, path.join(assetDir(wsDataDir, POST_ID), "photo.jpg"));

    const thumb = await serve(imageDerivativeUrl("thumb", hash));
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("Content-Type")).toBe("image/webp");
    expect(thumb.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(thumb.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const thumbInfo = await sharp(await bytes(thumb)).metadata();
    expect([thumbInfo.format, thumbInfo.width, thumbInfo.height]).toEqual(["webp", 360, 180]);

    const display = await serve(imageDerivativeUrl("display", hash));
    const displayInfo = await sharp(await bytes(display)).metadata();
    expect([displayInfo.format, displayInfo.width, displayInfo.height]).toEqual(["webp", 1600, 800]);
    expect(fs.readdirSync(thumbnails).sort()).toEqual([derivativeName(hash, "display"), derivativeName(hash, "thumb")]);
  });

  it("is a 404 for an image whose derivatives cannot be made", async () => {
    const cache = configureImageDerivatives(thumbnails);
    const broken = Buffer.from("not an image at all");
    const brokenHash = createHash("sha256").update(broken).digest("hex");
    const file = path.join(assetDir(wsDataDir, POST_ID), "broken.png");
    fs.writeFileSync(file, broken);
    cache.register(brokenHash, wsId, file);
    expect((await serve(imageDerivativeUrl("thumb", brokenHash))).status).toBe(404);
  });
});
