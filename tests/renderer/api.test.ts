import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActiveWorkspace, runAnalysisStream, fetchPosts, fetchWorkspaces } from "@renderer/api";
import type { AnalysisStreamHandle, BigMouthApi } from "@shared/ipc";

// api.ts is a thin adapter over the preload bridge (`window.bigmouth`); these
// tests assert the adapter's own behavior — workspace-id threading, the
// no-workspace guard, and the analysis-stream signal→abort wiring. The NDJSON
// frame-reassembly contract the old fetch-based streaming carried now lives in
// the preload, where it reassembles the per-request delta/done/error events.
function installBridge(overrides: Record<string, unknown> = {}): void {
  window.bigmouth = overrides as unknown as BigMouthApi;
}

describe("api bridge adapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setActiveWorkspace("");
    installBridge();
  });

  it("throws when no workspace is active for a scoped call", () => {
    expect(() => fetchPosts()).toThrow("No active workspace set");
  });

  it("threads the active workspace id into scoped calls", () => {
    const listPosts = vi.fn().mockResolvedValue({});
    installBridge({ listPosts });
    setActiveWorkspace("w1");
    void fetchPosts(0, 50, 0);
    expect(listPosts).toHaveBeenCalledWith("w1", 0, 50, 0);
  });

  it("forwards non-scoped calls without a workspace id", () => {
    const listWorkspaces = vi.fn().mockResolvedValue([]);
    installBridge({ listWorkspaces });
    void fetchWorkspaces();
    expect(listWorkspaces).toHaveBeenCalledWith();
  });

  describe("runAnalysisStream", () => {
    it("forwards params + onChunk and resolves with the bridge handle's done", async () => {
      let resolveDone!: () => void;
      const handle: AnalysisStreamHandle = {
        done: new Promise<void>((r) => (resolveDone = r)),
        abort: vi.fn(),
      };
      const runStream = vi.fn(() => handle);
      installBridge({ runAnalysisStream: runStream });
      setActiveWorkspace("w1");

      const onChunk = vi.fn();
      const promise = runAnalysisStream("p1", "Prompt", "content", { onChunk });
      expect(runStream).toHaveBeenCalledWith(
        { wsId: "w1", postId: "p1", promptName: "Prompt", content: "content" },
        onChunk,
      );
      resolveDone();
      await expect(promise).resolves.toBeUndefined();
    });

    it("wires an AbortSignal to the handle's abort", () => {
      const handle: AnalysisStreamHandle = { done: new Promise<void>(() => {}), abort: vi.fn() };
      installBridge({ runAnalysisStream: () => handle });
      setActiveWorkspace("w1");
      const controller = new AbortController();
      void runAnalysisStream("p1", "Prompt", "content", { onChunk: () => {}, signal: controller.signal });
      expect(handle.abort).not.toHaveBeenCalled();
      controller.abort();
      expect(handle.abort).toHaveBeenCalledTimes(1);
    });
  });
});
