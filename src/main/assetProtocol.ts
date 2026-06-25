import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { protocol } from "electron";

import { ASSET_SCHEME } from "@shared/ipc";
import { getWorkspace } from "./core/services/workspaceStore.js";
import { assetDir, safeResolveUnder } from "./core/services/assetStore.js";
import { error as logError, serializeError } from "./core/services/logger.js";

// Replaces the old HTTP `GET …/assets/:postId/:filename/raw` endpoint. The raw
// file is streamed from its own opaque origin (the custom scheme) with the same
// `nosniff` + `sandbox` hardening, so an uploaded HTML/SVG can never execute in
// the app's origin.

const POST_ID_RE = /^[A-Za-z0-9_-]+$/;
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

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

/** Registers the protocol handler — call once after `app.whenReady`. */
export function handleAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const notFound = new Response("Not found", { status: 404 });

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound;
    }
    // URL shape: bigmouth-asset://asset/<wsId>/<postId>/<filename>
    if (url.host !== "asset") return notFound;
    const segments = url.pathname.replace(/^\/+/, "").split("/");
    if (segments.length !== 3) return notFound;

    let wsId: string;
    let postId: string;
    let filename: string;
    try {
      wsId = decodeURIComponent(segments[0]);
      postId = decodeURIComponent(segments[1]);
      filename = decodeURIComponent(segments[2]);
    } catch {
      return notFound;
    }

    if (!POST_ID_RE.test(postId)) return notFound;
    const fn = readFilename(filename);
    if (!fn) return notFound;
    const ws = getWorkspace(wsId);
    if (!ws) return notFound;

    let filePath: string;
    try {
      filePath = safeResolveUnder(assetDir(ws.dataDirectory, postId), fn);
    } catch {
      return notFound;
    }
    if (!existsSync(filePath)) return notFound;

    let data: Buffer;
    try {
      data = await readFile(filePath);
    } catch (err) {
      logError("asset protocol read failed", { workspace: wsId, postId, filename: fn, error: serializeError(err) });
      return notFound;
    }

    const ext = path.extname(fn).slice(1).toLowerCase();
    const contentType = MIME_BY_EXT[ext] ?? "application/octet-stream";
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(data.byteLength),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
      },
    });
  });
}
