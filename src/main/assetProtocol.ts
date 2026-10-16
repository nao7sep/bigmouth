import type { FileHandle } from "node:fs/promises";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { protocol } from "electron";

import { ASSET_SCHEME } from "@shared/ipc";
import { getWorkspace } from "./storageAccess.js";
import { assetDir, safeResolveUnder } from "./core/services/assetStore.js";
import { error as logError, serializeError } from "./core/services/logger.js";
import { isPostId } from "./core/shared/filenames.js";
import { imageDerivatives, type ImageDerivativeKind } from "./imageDerivatives.js";

// Streams a raw asset file from its own opaque origin (the custom scheme) with
// `nosniff` + `sandbox` hardening, so an uploaded HTML/SVG can never execute in
// the app's origin.
//
// Files are streamed from disk in the read stream's 64 KB pieces, with byte
// ranges, so a request holds a piece at a time whatever the file's size, and
// they are read here in the main process with async I/O rather than through
// the storage worker, whose queue a large image would hold up and whose wait
// limit it could exceed (volume-handling-conventions).

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

const HARDENING = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox",
};

// A derivative's address is the hash of the bytes it was made from, so what it
// names never changes and the renderer may keep it as long as it likes.
const IMMUTABLE = "public, max-age=31536000, immutable";

/** Must run before `app.whenReady` — declares the scheme privileged. */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { secure: true, standard: true, stream: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

function readFilename(name: string): string | null {
  if (!name || name === "." || name === "..") return null;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
  if (path.basename(name) !== name) return null;
  return name;
}

export type ByteRange =
  | { kind: "whole" }
  | { kind: "part"; start: number; end: number }
  | { kind: "unsatisfiable" };

/**
 * The part of a `size`-byte file a `Range` header asks for. One range is
 * served: `bytes=a-b`, `bytes=a-` or a suffix `bytes=-n`, with an end past the
 * file cut to its last byte. A header that is malformed, names several ranges or
 * runs backwards is ignored, and the whole file is served, as RFC 9110 allows;
 * a range that starts past the end cannot be satisfied.
 */
export function byteRange(header: string | null, size: number): ByteRange {
  if (header === null) return { kind: "whole" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return { kind: "whole" };
  const first = match[1] === "" ? null : Number(match[1]);
  const last = match[2] === "" ? null : Number(match[2]);
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return { kind: "whole" };
  if (first === null) {
    // A suffix: the last `last` bytes.
    if (last === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "part", start: Math.max(0, size - last!), end: size - 1 };
  }
  if (last !== null && last < first) return { kind: "whole" };
  if (first >= size) return { kind: "unsatisfiable" };
  return { kind: "part", start: first, end: last === null ? size - 1 : Math.min(last, size - 1) };
}

const notFound = () => new Response("Not found", { status: 404 });

/**
 * Serves `filePath` whole or the range `request` asks for. The file is opened
 * once, and its size and bytes come from that one handle, so the length sent
 * is the length read even if the file is replaced meanwhile. A missing file is
 * a 404; a read that fails partway errors the body, which ends the response
 * without touching the app.
 */
export async function serveFile(
  filePath: string,
  contentType: string,
  request: Pick<Request, "headers">,
  extraHeaders: Record<string, string> = {},
  logFields: Record<string, unknown> = {},
): Promise<Response> {
  let handle: FileHandle;
  try {
    handle = await fsp.open(filePath, "r");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") logError("asset protocol read failed", { ...logFields, error: serializeError(err) });
    return notFound();
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      return notFound();
    }
    const size = stat.size;
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      ...HARDENING,
      ...extraHeaders,
    };
    const range = byteRange(request.headers?.get("Range") ?? null, size);
    if (range.kind === "unsatisfiable") {
      await handle.close();
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    }
    const [start, end] = range.kind === "part" ? [range.start, range.end] : [0, size - 1];
    const length = end - start + 1;
    if (range.kind === "part") headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    headers["Content-Length"] = String(length);
    const status = range.kind === "part" ? 206 : 200;
    if (length === 0) {
      await handle.close();
      return new Response(null, { status, headers });
    }
    // The stream closes the handle when it ends, fails or is cancelled.
    const body = Readable.toWeb(handle.createReadStream({ start, end })) as ReadableStream<Uint8Array>;
    return new Response(body, { status, headers });
  } catch (err) {
    await handle.close().catch(() => undefined);
    logError("asset protocol read failed", { ...logFields, error: serializeError(err) });
    return notFound();
  }
}

/**
 * Serves an asset by its place: bigmouth-asset://asset/<wsId>/<postId>/<filename>.
 * Every segment is validated and the path resolved under the post's asset
 * folder, so no request reaches a file outside it.
 */
async function serveAsset(request: Request, segments: string[]): Promise<Response> {
  if (segments.length !== 3) return notFound();

  let wsId: string;
  let postId: string;
  let filename: string;
  try {
    wsId = decodeURIComponent(segments[0]);
    postId = decodeURIComponent(segments[1]);
    filename = decodeURIComponent(segments[2]);
  } catch {
    return notFound();
  }

  if (!isPostId(postId)) return notFound();
  const fn = readFilename(filename);
  if (!fn) return notFound();
  const ws = (await getWorkspace(wsId));
  if (!ws) return notFound();

  let filePath: string;
  try {
    filePath = safeResolveUnder(assetDir(ws.dataDirectory, postId), fn);
  } catch {
    return notFound();
  }

  const ext = path.extname(fn).slice(1).toLowerCase();
  const contentType = MIME_BY_EXT[ext] ?? "application/octet-stream";
  return serveFile(filePath, contentType, request, {}, { workspace: wsId, postId, filename: fn });
}

/**
 * Serves an image's thumbnail or display image by its hash:
 * bigmouth-asset://thumb/<hash> or bigmouth-asset://display/<hash>. Only a hash
 * of an asset main has listed is served; a missing derivative is made first,
 * and one that cannot be made is a 404, so the window shows the file tile.
 */
async function serveDerivative(request: Request, kind: ImageDerivativeKind, segments: string[]): Promise<Response> {
  const cache = imageDerivatives();
  if (!cache || segments.length !== 1) return notFound();
  const file = await cache.resolve(segments[0], kind);
  if (!file) return notFound();
  return serveFile(file, "image/webp", request, { "Cache-Control": IMMUTABLE }, { derivative: kind, hash: segments[0] });
}

/** Answers one request to the scheme; every failure is a 404. */
export async function handleAssetRequest(request: Request): Promise<Response> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return notFound();
  }
  const segments = url.pathname.replace(/^\/+/, "").split("/");
  switch (url.host) {
    case "asset":
      return serveAsset(request, segments);
    case "thumb":
    case "display":
      return serveDerivative(request, url.host, segments);
    default:
      return notFound();
  }
}

/** Registers the protocol handler — call once after `app.whenReady`. */
export function handleAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    try {
      return await handleAssetRequest(request);
    } catch (err) {
      logError("asset protocol request failed", { error: serializeError(err) });
      return notFound();
    }
  });
}
