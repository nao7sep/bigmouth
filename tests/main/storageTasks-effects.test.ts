import { beforeEach, describe, expect, it, vi } from "vitest";
import { storageTasks } from "@main/storageTasks.js";
import { AssetRecordError } from "@main/core/services/assetStore.js";

const effects = vi.hoisted(() => ({
  getPost: vi.fn(), recordAssetChange: vi.fn(), assertUnambiguousPostId: vi.fn(), clearCache: vi.fn(),
  saveAssetFile: vi.fn(), deleteAsset: vi.fn(), getWorkspace: vi.fn(), deleteWorkspace: vi.fn(),
}));
vi.mock("@main/core/services/postStore.js", async (original) => ({
  ...await original<typeof import("@main/core/services/postStore.js")>(),
  getPost: effects.getPost, recordAssetChange: effects.recordAssetChange,
  assertUnambiguousPostId: effects.assertUnambiguousPostId, clearCache: effects.clearCache,
}));
vi.mock("@main/core/services/assetStore.js", async (original) => ({
  ...await original<typeof import("@main/core/services/assetStore.js")>(),
  saveAssetFile: effects.saveAssetFile, deleteAsset: effects.deleteAsset,
}));
vi.mock("@main/core/services/workspaceStore.js", async (original) => ({
  ...await original<typeof import("@main/core/services/workspaceStore.js")>(),
  getWorkspace: effects.getWorkspace, deleteWorkspace: effects.deleteWorkspace,
}));
vi.mock("@main/core/services/logger.js", async (original) => ({
  ...await original<typeof import("@main/core/services/logger.js")>(),
  error: vi.fn(), warn: vi.fn(), serializeError: (error: unknown) => error,
}));

const asset = { filename: "a.txt", size: 1, uploadedAt: "2026-01-01T00:00:00.000Z" };
const save = () => storageTasks.saveAssetFile("/workspace", "post", "a.txt", Buffer.from("a"), asset);

beforeEach(() => {
  vi.resetAllMocks();
  effects.getPost.mockReturnValue({ frontMatter: { locked: false } });
  effects.recordAssetChange.mockReturnValue({ frontMatter: {} });
  effects.saveAssetFile.mockReturnValue({ asset, changed: true });
  effects.getWorkspace.mockReturnValue({ dataDirectory: "/workspace" });
  effects.deleteWorkspace.mockReturnValue({});
});

describe("storage tasks own consequences before replying", () => {
  it("records a changed upload exactly once within its task", () => {
    expect(save()).toEqual({ ok: true, asset });
    expect(effects.recordAssetChange).toHaveBeenCalledExactlyOnceWith("/workspace", "post");
  });
  it("does not edit the post for an unchanged upload", () => {
    effects.saveAssetFile.mockReturnValue({ asset, changed: false });
    expect(save()).toEqual({ ok: true, asset });
    expect(effects.recordAssetChange).not.toHaveBeenCalled();
  });
  it("continues after published upload details fail", () => {
    effects.saveAssetFile.mockImplementation(() => { throw new AssetRecordError(asset, new Error("details")); });
    expect(save()).toEqual({ ok: true, asset, unsaved: ["details"] });
    expect(effects.recordAssetChange).toHaveBeenCalledTimes(1);
  });
  it.each(["missing", "failed"])("reports an incomplete modified time when the post is %s", (outcome) => {
    effects.recordAssetChange.mockImplementation(() => { if (outcome === "failed") throw new Error("write"); return null; });
    expect(save()).toEqual({ ok: true, asset, unsaved: ["modifiedTime"] });
  });
  it.each(["saved", "details-failed"])("records a successful asset removal once when details are %s", (outcome) => {
    if (outcome === "details-failed") effects.deleteAsset.mockImplementation(() => { throw new AssetRecordError(asset, new Error("details")); });
    expect(storageTasks.deleteAsset("/workspace", "post", "a.txt")).toEqual({});
    expect(effects.recordAssetChange).toHaveBeenCalledExactlyOnceWith("/workspace", "post");
  });
  it("reports a removed asset whose post cannot record the change", () => {
    effects.recordAssetChange.mockReturnValue(null);
    expect(storageTasks.deleteAsset("/workspace", "post", "a.txt")).toEqual({ unsaved: ["modifiedTime"] });
  });
  it.each(["upload", "delete"])("does not report a primary %s failure as partial success", (kind) => {
    const failure = new Error("primary write failed");
    (kind === "upload" ? effects.saveAssetFile : effects.deleteAsset).mockImplementation(() => { throw failure; });
    expect(() => kind === "upload" ? save() : storageTasks.deleteAsset("/workspace", "post", "a.txt")).toThrow(failure);
    expect(effects.recordAssetChange).not.toHaveBeenCalled();
  });
  it.each([{}, { keyCleanupIncomplete: true }])("evicts the removed workspace before returning %j", (result) => {
    effects.deleteWorkspace.mockReturnValue(result);
    expect(storageTasks.deleteWorkspace("workspace")).toBe(result);
    expect(effects.clearCache).toHaveBeenCalledExactlyOnceWith("/workspace");
  });
  it("preserves the cache if workspace removal failed", () => {
    effects.deleteWorkspace.mockImplementation(() => { throw new Error("registry failed"); });
    expect(() => storageTasks.deleteWorkspace("workspace")).toThrow("registry failed");
    expect(effects.clearCache).not.toHaveBeenCalled();
  });
  it("does not evict a workspace that was not removed", () => {
    effects.deleteWorkspace.mockReturnValue(null);
    expect(storageTasks.deleteWorkspace("workspace")).toBeNull();
    expect(effects.clearCache).not.toHaveBeenCalled();
  });
  it.each(["upload", "delete"])("refuses a locked post before %s publication", (kind) => {
    effects.getPost.mockReturnValue({ frontMatter: { locked: true } });
    expect(() => kind === "upload" ? save() : storageTasks.deleteAsset("/workspace", "post", "a.txt")).toThrow("locked");
    expect(effects.saveAssetFile).not.toHaveBeenCalled();
    expect(effects.deleteAsset).not.toHaveBeenCalled();
    expect(effects.recordAssetChange).not.toHaveBeenCalled();
  });
});
