import { beforeEach, describe, expect, it, vi } from "vitest";
import { storageTasks } from "@main/storageTasks.js";
import { AssetRecordError } from "@main/core/services/assetStore.js";

const effects = vi.hoisted(() => ({
  getPost: vi.fn(), recordAssetChange: vi.fn(), assertUnambiguousPostId: vi.fn(), clearCache: vi.fn(),
  installAsset: vi.fn(), deleteAsset: vi.fn(), getWorkspace: vi.fn(), removeWorkspace: vi.fn(),
  sweepStaging: vi.fn(), unreadablePosts: vi.fn(),
}));
vi.mock("@main/core/services/postStore.js", async (original) => ({
  ...await original<typeof import("@main/core/services/postStore.js")>(),
  getPost: effects.getPost, recordAssetChange: effects.recordAssetChange,
  assertUnambiguousPostId: effects.assertUnambiguousPostId, clearCache: effects.clearCache,
  unreadablePosts: effects.unreadablePosts,
}));
vi.mock("@main/core/services/assetStore.js", async (original) => ({
  ...await original<typeof import("@main/core/services/assetStore.js")>(),
  installAsset: effects.installAsset, deleteAsset: effects.deleteAsset, sweepStaging: effects.sweepStaging,
}));
vi.mock("@main/core/services/workspaceStore.js", async (original) => ({
  ...await original<typeof import("@main/core/services/workspaceStore.js")>(),
  getWorkspace: effects.getWorkspace, removeWorkspace: effects.removeWorkspace,
}));
vi.mock("@main/core/services/logger.js", async (original) => ({
  ...await original<typeof import("@main/core/services/logger.js")>(),
  error: vi.fn(), warn: vi.fn(), serializeError: (error: unknown) => error,
}));

const asset = { filename: "a.txt", size: 1, uploadedAt: "2026-01-01T00:00:00.000Z" };
const save = () => storageTasks.installAsset("/workspace", "post", "a.txt", { name: "staged.part", sha256: "00", size: 1 }, asset);

beforeEach(() => {
  vi.resetAllMocks();
  effects.getPost.mockReturnValue({ frontMatter: { locked: false } });
  effects.recordAssetChange.mockReturnValue({ frontMatter: {} });
  effects.installAsset.mockReturnValue({ asset, changed: true });
  effects.getWorkspace.mockReturnValue({ dataDirectory: "/workspace" });
  effects.removeWorkspace.mockReturnValue({});
});

describe("storage tasks own consequences before replying", () => {
  it("records a changed upload exactly once within its task", () => {
    expect(save()).toEqual({ ok: true, asset });
    expect(effects.recordAssetChange).toHaveBeenCalledExactlyOnceWith("/workspace", "post");
  });
  it("does not edit the post for an unchanged upload", () => {
    effects.installAsset.mockReturnValue({ asset, changed: false });
    expect(save()).toEqual({ ok: true, asset });
    expect(effects.recordAssetChange).not.toHaveBeenCalled();
  });
  it("continues after published upload details fail", () => {
    effects.installAsset.mockImplementation(() => { throw new AssetRecordError(asset, new Error("details")); });
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
    (kind === "upload" ? effects.installAsset : effects.deleteAsset).mockImplementation(() => { throw failure; });
    expect(() => kind === "upload" ? save() : storageTasks.deleteAsset("/workspace", "post", "a.txt")).toThrow(failure);
    expect(effects.recordAssetChange).not.toHaveBeenCalled();
  });
  it.each([{}, { keyCleanupIncomplete: true }])("evicts the removed workspace before returning %j", (result) => {
    effects.removeWorkspace.mockReturnValue(result);
    expect(storageTasks.removeWorkspace("workspace")).toBe(result);
    expect(effects.clearCache).toHaveBeenCalledExactlyOnceWith("/workspace");
  });
  it("preserves the cache if workspace removal failed", () => {
    effects.removeWorkspace.mockImplementation(() => { throw new Error("registry failed"); });
    expect(() => storageTasks.removeWorkspace("workspace")).toThrow("registry failed");
    expect(effects.clearCache).not.toHaveBeenCalled();
  });
  it("does not evict a workspace that was not removed", () => {
    effects.removeWorkspace.mockReturnValue(null);
    expect(storageTasks.removeWorkspace("workspace")).toBeNull();
    expect(effects.clearCache).not.toHaveBeenCalled();
  });
  it("refuses a locked post before delete publication", () => {
    effects.getPost.mockReturnValue({ frontMatter: { locked: true } });
    expect(() => storageTasks.deleteAsset("/workspace", "post", "a.txt")).toThrow("locked");
    expect(effects.deleteAsset).not.toHaveBeenCalled();
    expect(effects.recordAssetChange).not.toHaveBeenCalled();
  });
  // An upload's bytes stream in before publication, so the post is checked again
  // here and a refusal is a result, not an exception.
  it.each([
    ["locked", { frontMatter: { locked: true } }, "post-locked"],
    ["deleted", null, "post-missing"],
  ] as const)("refuses to publish an upload to a post %s meanwhile", (_label, post, code) => {
    effects.getPost.mockReturnValue(post);
    expect(save()).toEqual({ ok: false, admission: { code } });
    expect(effects.installAsset).not.toHaveBeenCalled();
    expect(effects.recordAssetChange).not.toHaveBeenCalled();
  });
  it.each([
    ["ENOSPC", "full"],
    ["EACCES", "denied"],
    ["EIO", "failed"],
  ] as const)("reports a %s install as a write the workspace folder refused", (code, problem) => {
    effects.installAsset.mockImplementation(() => { throw Object.assign(new Error(`${code}: /secret/path`), { code }); });
    expect(save()).toEqual({ ok: false, failure: { code: "workspace-unwritable", problem } });
    expect(effects.recordAssetChange).not.toHaveBeenCalled();
  });
  it("clears a workspace's leftover staged uploads at its first post listing of the launch, once", () => {
    effects.unreadablePosts.mockReturnValue([]);
    storageTasks.unreadablePosts("/swept-workspace");
    storageTasks.unreadablePosts("/swept-workspace");
    expect(effects.sweepStaging).toHaveBeenCalledExactlyOnceWith("/swept-workspace");
    expect(effects.unreadablePosts).toHaveBeenCalledTimes(2);
  });
  it("lists the posts even when the staging folder cannot be cleared", () => {
    effects.unreadablePosts.mockReturnValue([]);
    effects.sweepStaging.mockImplementation(() => { throw new Error("EACCES"); });
    expect(storageTasks.unreadablePosts("/unsweepable-workspace")).toEqual([]);
  });
});
