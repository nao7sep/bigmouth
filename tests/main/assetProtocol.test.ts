// Covers the custom asset-scheme handler's request validation and hardening:
// only a well-formed bigmouth-asset://asset/<wsId>/<postId>/<file> for an existing
// workspace + on-disk file yields 200 (with nosniff/sandbox headers); everything
// malformed, traversing, or missing yields 404. The electron `protocol` is mocked
// to capture the registered handler; the workspace + asset file are real.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ASSET_SCHEME, assetUrl } from "@shared/ipc";

const captured = vi.hoisted(() => ({
  handler: null as null | ((req: { url: string }) => Promise<Response>),
  privileged: null as null | unknown,
}));

vi.mock("electron", () => ({
  protocol: {
    registerSchemesAsPrivileged: (schemes: unknown) => {
      captured.privileged = schemes;
    },
    handle: (_scheme: string, h: (req: { url: string }) => Promise<Response>) => {
      captured.handler = h;
    },
  },
}));

vi.mock("@main/core/services/logger.js", () => ({
  error: () => {},
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));

import { registerAssetScheme, handleAssetProtocol } from "@main/assetProtocol.js";
import { initAppDir, createWorkspace } from "@main/core/services/workspaceStore.js";
import { assetDir } from "@main/core/services/assetStore.js";

let home: string;
let wsId: string;
const POST_ID = "post1";
const SAVED_HOME = process.env.BIGMOUTH_HOME;

function serve(url: string): Promise<Response> {
  return captured.handler!({ url });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-assetproto-"));
  process.env.BIGMOUTH_HOME = home;
  initAppDir();
  const ws = createWorkspace("WS");
  wsId = ws.id;
  // A real asset file under the workspace's per-post asset directory.
  const dir = assetDir(ws.dataDirectory, POST_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pic.png"), Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(path.join(dir, "data.bin"), Buffer.from([9, 9]));
  handleAssetProtocol();
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
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
