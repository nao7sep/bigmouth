import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActiveWorkspace, runAnalysisStream, listPosts, listWorkspaces } from "@renderer/api";
import type { AnalysisStreamHandle, BigMouthApi } from "@shared/ipc";

// api.ts is a thin adapter over the preload bridge (`window.bigmouth`); these
// tests assert the adapter's own behavior — workspace-id threading, the
// no-workspace guard, and the analysis-stream signal→abort wiring. The bridge
// itself reassembles the per-request delta/done/error frames in the preload.
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
    expect(() => listPosts()).toThrow("No active workspace set");
  });

  it("threads the active workspace id into scoped calls", () => {
    const listPostsBridge = vi.fn().mockResolvedValue({});
    installBridge({ listPosts: listPostsBridge });
    setActiveWorkspace("w1");
    void listPosts(0, 50, 0);
    expect(listPostsBridge).toHaveBeenCalledWith("w1", 0, 50, 0);
  });

  it("forwards non-scoped calls without a workspace id", () => {
    const listWorkspacesBridge = vi.fn().mockResolvedValue([]);
    installBridge({ listWorkspaces: listWorkspacesBridge });
    void listWorkspaces();
    expect(listWorkspacesBridge).toHaveBeenCalledWith();
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
