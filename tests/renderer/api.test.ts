import { describe, it, expect, beforeEach, vi } from "vitest";
import { DEFAULT_CONTENT_FONT } from "@shared/types";
import {
  setActiveWorkspace,
  runAnalysisStream,
  listPosts,
  listWorkspaces,
  openOrCreateWorkspace,
  updateWorkspace,
  deleteWorkspace,
  pickWorkspaceDirectory,
  getPost,
  createPost,
  updatePost,
  changePostStatus,
  deletePost,
  listReferrers,
  rebuildPostIndex,
  listTargets,
  saveTargets,
  renameTarget,
  getSettings,
  saveSettings,
  listAiConfigs,
  createAiConfig,
  updateAiConfig,
  deleteAiConfig,
  setActiveAiConfig,
  listAssets,
  uploadAsset,
  deleteAsset,
  generateMetadataField,
  generateMetadataFields,
  generateImaging,
  assetUrl,
} from "@renderer/api";
import type { AnalysisStreamHandle, BigMouthApi } from "@shared/ipc";
import type { ImagingOptions } from "@shared/types";

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

// Each wrapper is a one-line forward to the bridge; these tests assert the
// call-through shape: that the active workspace id is threaded in the right
// position and the remaining arguments are passed through unchanged.
describe("api wrappers — call-through and argument shape", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setActiveWorkspace("");
    installBridge();
  });

  // A bridge stub where every method is a resolved spy; the returned `bridge`
  // object lets the tests assert how each method was called.
  function bridge() {
    const stub: Record<string, ReturnType<typeof vi.fn>> = {};
    return new Proxy(stub, {
      get(target, prop: string) {
        if (!(prop in target)) target[prop] = vi.fn().mockResolvedValue(undefined);
        return target[prop];
      },
    });
  }

  describe("workspace management (no workspace context)", () => {
    it("openOrCreateWorkspace forwards name + dataDirectory", () => {
      const b = bridge();
      installBridge(b);
      void openOrCreateWorkspace("Name", "/data");
      expect(b.openOrCreateWorkspace).toHaveBeenCalledWith("Name", "/data");
    });

    it("updateWorkspace forwards id + updates", () => {
      const b = bridge();
      installBridge(b);
      void updateWorkspace("w1", { name: "New" });
      expect(b.updateWorkspace).toHaveBeenCalledWith("w1", { name: "New" });
    });

    it("deleteWorkspace forwards the id", () => {
      const b = bridge();
      installBridge(b);
      void deleteWorkspace("w1");
      expect(b.deleteWorkspace).toHaveBeenCalledWith("w1");
    });

    it("pickWorkspaceDirectory forwards to the bridge's pickDirectory", () => {
      const b = bridge();
      installBridge(b);
      void pickWorkspaceDirectory();
      expect(b.pickDirectory).toHaveBeenCalledWith();
    });
  });

  describe("posts", () => {
    beforeEach(() => setActiveWorkspace("w1"));

    it("getPost honors an explicit workspace override", () => {
      const b = bridge();
      installBridge(b);
      void getPost("p1", "other");
      expect(b.getPost).toHaveBeenCalledWith("other", "p1");
    });

    it("getPost falls back to the active workspace", () => {
      const b = bridge();
      installBridge(b);
      void getPost("p1");
      expect(b.getPost).toHaveBeenCalledWith("w1", "p1");
    });

    it("createPost threads ws then target/language/sourceId", () => {
      const b = bridge();
      installBridge(b);
      void createPost("blog", "en", "src1");
      expect(b.createPost).toHaveBeenCalledWith("w1", "blog", "en", "src1");
    });

    it("updatePost passes the updates payload through as PostUpdate", () => {
      const b = bridge();
      installBridge(b);
      void updatePost("p1", { content: "x", frontMatter: { title: "T" } });
      expect(b.updatePost).toHaveBeenCalledWith("w1", "p1", {
        content: "x",
        frontMatter: { title: "T" },
      });
    });

    it("updatePost honors a workspace override", () => {
      const b = bridge();
      installBridge(b);
      void updatePost("p1", { content: "x" }, "other");
      expect(b.updatePost).toHaveBeenCalledWith("other", "p1", { content: "x" });
    });

    it("changePostStatus forwards ws/id/status", () => {
      const b = bridge();
      installBridge(b);
      void changePostStatus("p1", "ready", "other");
      expect(b.changePostStatus).toHaveBeenCalledWith("other", "p1", "ready");
    });

    it("deletePost forwards ws/id", () => {
      const b = bridge();
      installBridge(b);
      void deletePost("p1");
      expect(b.deletePost).toHaveBeenCalledWith("w1", "p1");
    });

    it("listReferrers forwards ws/id", () => {
      const b = bridge();
      installBridge(b);
      void listReferrers("p1");
      expect(b.listReferrers).toHaveBeenCalledWith("w1", "p1");
    });

    it("rebuildPostIndex forwards the active ws", () => {
      const b = bridge();
      installBridge(b);
      void rebuildPostIndex();
      expect(b.rebuildPostIndex).toHaveBeenCalledWith("w1");
    });
  });

  describe("targets", () => {
    beforeEach(() => setActiveWorkspace("w1"));

    it("listTargets forwards the active ws", () => {
      const b = bridge();
      installBridge(b);
      void listTargets();
      expect(b.listTargets).toHaveBeenCalledWith("w1");
    });

    it("saveTargets forwards ws + targets", () => {
      const b = bridge();
      installBridge(b);
      const targets = [{ name: "blog", defaultLanguage: "en", requiresMetadata: true }];
      void saveTargets(targets);
      expect(b.saveTargets).toHaveBeenCalledWith("w1", targets);
    });

    it("renameTarget forwards ws + old/new names", () => {
      const b = bridge();
      installBridge(b);
      void renameTarget("old", "new");
      expect(b.renameTarget).toHaveBeenCalledWith("w1", "old", "new");
    });
  });

  describe("settings", () => {
    beforeEach(() => setActiveWorkspace("w1"));

    it("getSettings forwards the active ws", () => {
      const b = bridge();
      installBridge(b);
      void getSettings();
      expect(b.getSettings).toHaveBeenCalledWith("w1");
    });

    it("saveSettings forwards ws + settings", () => {
      const b = bridge();
      installBridge(b);
      const settings = {
        timezone: "UTC",
        supportedLanguages: ["en"],
        publishedPostsPerLoad: 50,
        maxUploadMb: 500,
        editorWatermark: "",
        extraFieldWatermark: "",
        uiFontFamily: "",
        contentFont: DEFAULT_CONTENT_FONT,
      };
      void saveSettings(settings);
      expect(b.saveSettings).toHaveBeenCalledWith("w1", settings);
    });
  });

  describe("AI configs", () => {
    beforeEach(() => setActiveWorkspace("w1"));

    it("listAiConfigs forwards the active ws", () => {
      const b = bridge();
      installBridge(b);
      void listAiConfigs();
      expect(b.listAiConfigs).toHaveBeenCalledWith("w1");
    });

    it("createAiConfig forwards ws + the AiConfigInput", () => {
      const b = bridge();
      installBridge(b);
      const input = { id: "c1", name: "C", provider: "anthropic" as const, model: "m", apiKey: "k" };
      void createAiConfig(input);
      expect(b.createAiConfig).toHaveBeenCalledWith("w1", input);
    });

    it("updateAiConfig forwards ws + id + patch", () => {
      const b = bridge();
      installBridge(b);
      void updateAiConfig("c1", { name: "New", apiKey: "k2" });
      expect(b.updateAiConfig).toHaveBeenCalledWith("w1", "c1", { name: "New", apiKey: "k2" });
    });

    it("deleteAiConfig forwards ws + id", () => {
      const b = bridge();
      installBridge(b);
      void deleteAiConfig("c1");
      expect(b.deleteAiConfig).toHaveBeenCalledWith("w1", "c1");
    });

    it("setActiveAiConfig forwards ws + id", () => {
      const b = bridge();
      installBridge(b);
      void setActiveAiConfig("c1");
      expect(b.setActiveAiConfig).toHaveBeenCalledWith("w1", "c1");
    });
  });

  describe("assets", () => {
    beforeEach(() => setActiveWorkspace("w1"));

    it("listAssets forwards ws + postId", () => {
      const b = bridge();
      installBridge(b);
      void listAssets("p1");
      expect(b.listAssets).toHaveBeenCalledWith("w1", "p1");
    });

    it("listAssets honors a workspace override", () => {
      const b = bridge();
      installBridge(b);
      void listAssets("p1", "other");
      expect(b.listAssets).toHaveBeenCalledWith("other", "p1");
    });

    it("uploadAsset reads the File to bytes and forwards name + data", async () => {
      const b = bridge();
      installBridge(b);
      const buffer = new TextEncoder().encode("hello").buffer;
      // A minimal File stand-in exposing name + arrayBuffer().
      const file = {
        name: "pic.png",
        arrayBuffer: vi.fn().mockResolvedValue(buffer),
      } as unknown as File;
      await uploadAsset("p1", file);
      expect(file.arrayBuffer).toHaveBeenCalled();
      expect(b.uploadAsset).toHaveBeenCalledWith("w1", "p1", { name: "pic.png", data: buffer });
    });

    it("deleteAsset forwards ws + postId + filename", () => {
      const b = bridge();
      installBridge(b);
      void deleteAsset("p1", "pic.png", "other");
      expect(b.deleteAsset).toHaveBeenCalledWith("other", "p1", "pic.png");
    });
  });

  describe("metadata generation", () => {
    beforeEach(() => setActiveWorkspace("w1"));

    it("generateMetadataFields forwards ws + postId + fields + content", () => {
      const b = bridge();
      installBridge(b);
      void generateMetadataFields("p1", ["title", "slug"], "body");
      expect(b.generateMetadata).toHaveBeenCalledWith("w1", "p1", ["title", "slug"], "body");
    });

    it("generateMetadataField returns the value for a single field on success", async () => {
      installBridge({
        generateMetadata: vi.fn().mockResolvedValue({ title: { value: "Generated" } }),
      });
      await expect(generateMetadataField("p1", "title", "body")).resolves.toBe("Generated");
    });

    it("generateMetadataField throws the field's error when generation fails", async () => {
      installBridge({
        generateMetadata: vi.fn().mockResolvedValue({ title: { error: "no key" } }),
      });
      await expect(generateMetadataField("p1", "title", "body")).rejects.toThrow("no key");
    });

    it("generateMetadataField throws a default message when the field is missing", async () => {
      installBridge({ generateMetadata: vi.fn().mockResolvedValue({}) });
      await expect(generateMetadataField("p1", "slug", "body")).rejects.toThrow(
        "Failed to generate slug",
      );
    });
  });

  describe("imaging", () => {
    beforeEach(() => setActiveWorkspace("w1"));

    const options: ImagingOptions = {
      count: 3,
      relation: "direct",
      emotionalLens: "calm",
      literalness: "literal",
      people: "no-people",
      style: "photo",
    };

    it("forwards ws + postId + content + options and resolves the bridge result", async () => {
      const generateImagingBridge = vi.fn().mockResolvedValue(["url1", "url2"]);
      installBridge({ generateImaging: generateImagingBridge });
      await expect(generateImaging("p1", "body", options)).resolves.toEqual(["url1", "url2"]);
      expect(generateImagingBridge).toHaveBeenCalledWith("w1", "p1", "body", options);
    });

    it("rejects immediately when the signal is already aborted", async () => {
      installBridge({ generateImaging: vi.fn().mockResolvedValue([]) });
      const controller = new AbortController();
      controller.abort();
      await expect(generateImaging("p1", "body", options, controller.signal)).rejects.toThrow(
        /aborted/i,
      );
    });

    it("rejects when the signal aborts while in flight", async () => {
      // A never-settling bridge promise so the abort wins the race.
      installBridge({ generateImaging: vi.fn(() => new Promise<string[]>(() => {})) });
      const controller = new AbortController();
      const promise = generateImaging("p1", "body", options, controller.signal);
      controller.abort();
      await expect(promise).rejects.toThrow(/aborted/i);
    });
  });

  describe("assetUrl", () => {
    it("builds a custom-protocol URL with the active workspace id", () => {
      setActiveWorkspace("w1");
      expect(assetUrl("p1", "pic.png")).toBe("bigmouth-asset://asset/w1/p1/pic.png");
    });

    it("honors a workspace override and url-encodes the segments", () => {
      setActiveWorkspace("w1");
      expect(assetUrl("p 1", "a b.png", "ws/2")).toBe(
        "bigmouth-asset://asset/ws%2F2/p%201/a%20b.png",
      );
    });
  });
});
