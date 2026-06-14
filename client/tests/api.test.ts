import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActiveWorkspace, runAnalysisStream } from "../src/api";

// A minimal fake of the streaming Response surface runAnalysisStream consumes:
// `.ok`/`.status`, a chunked `.body.getReader()`, and `.text()`. Driving it by
// explicit chunks lets us assert the NDJSON-frame contract deterministically,
// including frames split across reads.
function streamResponse(chunks: string[], status = 200): Response {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader() {
        return {
          read: async () =>
            i < chunks.length
              ? { done: false, value: enc.encode(chunks[i++]) }
              : { done: true, value: undefined },
          releaseLock() {},
        };
      },
    },
    text: async () => chunks.join(""),
  } as unknown as Response;
}

function errorResponse(body: unknown, status: number): Response {
  return {
    ok: false,
    status,
    body: null,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const frame = (obj: unknown) => JSON.stringify(obj) + "\n";

describe("runAnalysisStream", () => {
  beforeEach(() => setActiveWorkspace("w1"));
  afterEach(() => vi.restoreAllMocks());

  it("delivers delta frames and resolves on a done frame", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        streamResponse([
          frame({ type: "delta", text: "Hello " }),
          frame({ type: "delta", text: "world" }),
          frame({ type: "done" }),
        ]),
      ),
    );
    const chunks: string[] = [];
    await runAnalysisStream("p1", "Prompt", "content", { onChunk: (d) => chunks.push(d) });
    expect(chunks.join("")).toBe("Hello world");
  });

  it("throws on an error frame after delivering the partial text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        streamResponse([
          frame({ type: "delta", text: "partial" }),
          frame({ type: "error", message: "provider exploded" }),
        ]),
      ),
    );
    const chunks: string[] = [];
    await expect(
      runAnalysisStream("p1", "Prompt", "content", { onChunk: (d) => chunks.push(d) }),
    ).rejects.toThrow("provider exploded");
    expect(chunks.join("")).toBe("partial");
  });

  it("throws when the stream ends without a done frame (silent truncation)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(streamResponse([frame({ type: "delta", text: "cut short" })])),
    );
    await expect(
      runAnalysisStream("p1", "Prompt", "content", { onChunk: () => {} }),
    ).rejects.toThrow(/unexpectedly/i);
  });

  it("reassembles a frame split across read chunks", async () => {
    const f = frame({ type: "delta", text: "abc" });
    const mid = Math.floor(f.length / 2);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        streamResponse([f.slice(0, mid), f.slice(mid), frame({ type: "done" })]),
      ),
    );
    const chunks: string[] = [];
    await runAnalysisStream("p1", "Prompt", "content", { onChunk: (d) => chunks.push(d) });
    expect(chunks.join("")).toBe("abc");
  });

  it("surfaces a pre-stream HTTP error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(errorResponse({ error: "no active AI config" }, 503)),
    );
    await expect(
      runAnalysisStream("p1", "Prompt", "content", { onChunk: () => {} }),
    ).rejects.toThrow("no active AI config");
  });
});
