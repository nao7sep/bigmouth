import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditPendingError, StorageOwner, type StorageRequest, type StorageFlushRequest, storageOwner } from "@main/storageOwner.js";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const sent = vi.hoisted(() => [] as { channel: string; payload: unknown }[]);
vi.mock("electron", () => ({ ipcMain: {
  on: (channel: string, callback: (...args: unknown[]) => unknown) => handlers.set(channel, callback),
  handle: (channel: string, callback: (...args: unknown[]) => unknown) => handlers.set(channel, callback),
}, BrowserWindow: { getAllWindows: () => [{ webContents: {
  isDestroyed: () => false,
  send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
} }] } }));

class HeldWorker extends EventEmitter {
  requests: StorageRequest[] = [];
  unref(): void {}
  postMessage(request: StorageRequest): void { this.requests.push(request); }
  async terminate(): Promise<number> { return 0; }
}

afterEach(() => { vi.useRealTimers(); });

describe("storage mutation ownership", () => {
  it("ends the caller wait while retaining the actual mutation claim until it settles", async () => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    try {
      const held = owner.run("updateUiState", [{ zoomLevel: 1 }], 10).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      expect(await held).toBeInstanceOf(Error);
      await expect(owner.run("updateUiState", [{ zoomLevel: 2 }])).rejects.toThrow("previous operation settles");
      expect(worker.requests).toHaveLength(1);
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
      const next = owner.run("updateUiState", [{ zoomLevel: 3 }]);
      expect(worker.requests).toHaveLength(2);
      worker.emit("message", { id: worker.requests[1].id, ok: true, value: { zoomLevel: 3 } });
      expect((await next).zoomLevel).toBe(3);
    } finally { await owner.stop(); }
  });

  it("holds an edit storage cannot take yet and delivers it once storage takes work again", async () => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    try {
      const held = owner.run("getUiState", [], 10).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10);
      await held;
      await expect(owner.run("queueContent", ["/workspace", "post", "typed while blocked"])).rejects.toBeInstanceOf(EditPendingError);
      expect(worker.requests).toHaveLength(1);
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
      expect(worker.requests[1]).toMatchObject({ name: "queueContent", args: ["/workspace", "post", "typed while blocked"] });
    } finally { await owner.stop(); }
  });

  it("keeps an edit whose wait expires in its queue position, ahead of a later lock", async () => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    try {
      const read = owner.run("getUiState", [], 1000).catch(() => undefined);
      const edit = owner.run("queueContent", ["/workspace", "post", "queued behind a read"], 10).catch((error: unknown) => error);
      const lock = owner.run("setLocked", ["/workspace", "post", true], 1000).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10);
      expect(await edit).toBeInstanceOf(EditPendingError);
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
      await read;
      expect(worker.requests[1]).toMatchObject({ name: "queueContent", args: ["/workspace", "post", "queued behind a read"] });
      worker.emit("message", { id: worker.requests[1].id, ok: true, value: undefined });
      expect(worker.requests[2].name).toBe("setLocked");
      worker.emit("message", { id: worker.requests[2].id, ok: true, value: null });
      await lock;
    } finally { await owner.stop(); }
  });

  it("keeps a cancelled quit's resumption in its queue position when its wait expires", async () => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    try {
      const read = owner.run("getUiState", [], 1000).catch(() => undefined);
      const resume = owner.run("resumePendingFlushes", [], 10).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      expect(await resume).toBeInstanceOf(Error);
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
      await read;
      expect(worker.requests[1].name).toBe("resumePendingFlushes");
    } finally { await owner.stop(); }
  });

  it("delivers only the newest held content and every held metadata edit, in order", async () => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    const failures: unknown[] = [];
    owner.onHeldEditFailed((_request, failure) => failures.push(failure));
    try {
      const held = owner.run("getUiState", [], 10).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10);
      await held;
      for (const run of [
        () => owner.run("queueMetadata", ["/workspace", "post", { title: "first", slug: "kept" }]),
        () => owner.run("queueContent", ["/workspace", "post", "older text"]),
        () => owner.run("queueMetadata", ["/workspace", "post", { title: "second" }]),
        () => owner.run("queueContent", ["/workspace", "post", "newest text"]),
        () => owner.run("queueMetadata", ["/workspace", "post", { title: "third" }]),
      ]) await expect(run()).rejects.toBeInstanceOf(EditPendingError);
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
      for (let index = 1; index < 5; index++) worker.emit("message", { id: worker.requests[index].id, ok: true, value: index === 4 ? { key: "metadata.refusedInvalid" } : null });
      // Each metadata edit is validated on its own, so a refused later value
      // never takes an earlier accepted one with it.
      expect(worker.requests.slice(1).map((request) => request.args[2])).toEqual([{ title: "first", slug: "kept" }, { title: "second" }, "newest text", { title: "third" }]);
      // A refusal on delivery reaches the listener, since its caller was answered when it was held.
      expect(failures).toEqual([{ key: "metadata.refusedInvalid" }]);
    } finally { await owner.stop(); }
  });

  it("never sends an edit the worker already accepted back with the quit flush", async () => {
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    let flushRequest: StorageFlushRequest | undefined;
    try {
      const edit = owner.run("queueContent", ["/workspace", "post", "accepted"]);
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: undefined });
      await edit;
      const flushing = owner.flushAsync(1000);
      flushRequest = worker.requests[1] as unknown as StorageFlushRequest;
      // The worker's buffer owns the accepted edit; replaying it could only
      // re-queue text that a lock or status write had already saved.
      expect(flushRequest.edits).toEqual([]);
      worker.emit("message", { event: "flush-settled" });
      flushRequest.port.postMessage({ failures: [] });
      expect(await flushing).toEqual({ kind: "flushed", failures: [] });
    } finally { flushRequest?.port.close(); await owner.stop(); }
  });

  it("captures the real IPC packet and authored instant while storage settles, and shows it as retrying", async () => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    const spy = vi.spyOn(storageOwner, "run").mockImplementation((name, args) => owner.run(name, args));
    try {
      const { registerPostHandlers } = await import("@main/ipc/posts.js");
      const { CHANNELS } = await import("@shared/ipc");
      registerPostHandlers();
      const held = owner.run("getUiState", [], 10).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10);
      await held;
      const authored = Date.now();
      await handlers.get(CHANNELS.queuePostContent)!({}, "workspace-id", "post", "newest text");
      expect(await handlers.get(CHANNELS.queuePostMetadata)!({}, "workspace-id", "post", { title: "held title" })).toBeNull();
      expect(worker.requests).toHaveLength(1);
      // Held, not lost: the post shows the retrying state, never "workspace could not be opened".
      expect(sent.filter((item) => item.channel === CHANNELS.postContentSaveFailed).map((item) => item.payload))
        .toEqual([expect.objectContaining({ postId: "post", kind: "retrying" }), expect.objectContaining({ postId: "post", kind: "retrying" })]);
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
      expect(worker.requests[1].name).toBe("queueWorkspaceContent");
      expect(worker.requests[1].args).toEqual(["workspace-id", "post", "newest text", new Date(authored)]);
      worker.emit("message", { id: worker.requests[1].id, ok: true, value: undefined });
      expect(worker.requests[2]).toMatchObject({ name: "queueWorkspaceMetadata", args: ["workspace-id", "post", { title: "held title" }, new Date(authored)] });
    } finally { spy.mockRestore(); await owner.stop(); }
  });

  it("knows when content for a post has not reached the worker yet", async () => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    try {
      const slow = owner.run("getUiState", [], 10).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10);
      await slow;
      await expect(owner.run("queueContent", ["/workspace", "post", "held"])).rejects.toBeInstanceOf(EditPendingError);
      expect(owner.holdsContentFor("post")).toBe(true);
      expect(owner.holdsContentFor("other")).toBe(false);
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
      // Sent, but the worker has not replied: still on this side.
      expect(worker.requests[1].name).toBe("queueContent");
      expect(owner.holdsContentFor("post")).toBe(true);
      worker.emit("message", { id: worker.requests[1].id, ok: true, value: undefined });
      expect(owner.holdsContentFor("post")).toBe(false);
    } finally { await owner.stop(); }
  });

  it("marks a save as not the latest while newer text for the post is held", async () => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    const run = vi.spyOn(storageOwner, "run").mockImplementation((name, args) => owner.run(name, args));
    const holds = vi.spyOn(storageOwner, "holdsContentFor").mockImplementation((id) => owner.holdsContentFor(id));
    sent.length = 0;
    try {
      const { registerPostHandlers } = await import("@main/ipc/posts.js");
      const { CHANNELS } = await import("@shared/ipc");
      registerPostHandlers();
      owner.onContentSave((storageOwner as unknown as { contentListener: Parameters<StorageOwner["onContentSave"]>[0] }).contentListener);
      const slow = owner.run("getUiState", [], 10).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10);
      await slow;
      await handlers.get(CHANNELS.queuePostContent)!({}, "workspace-id", "post", "newer text");
      const summary = { id: "post" };
      // An older buffered save lands while the newer text waits.
      worker.emit("message", { event: "content-save", value: { kind: "saved", dataDir: "/d", id: "post", summary } });
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
      worker.emit("message", { id: worker.requests[1].id, ok: true, value: undefined });
      worker.emit("message", { event: "content-save", value: { kind: "saved", dataDir: "/d", id: "post", summary } });
      expect(sent.filter((item) => item.channel === CHANNELS.postContentSaved).map((item) => item.payload))
        .toEqual([{ postId: "post", summary, newerEditHeld: true }, { postId: "post", summary, newerEditHeld: false }]);
    } finally { run.mockRestore(); holds.mockRestore(); await owner.stop(); }
  });

  it("sends a held metadata edit the store refused on delivery back to its field", async () => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    const run = vi.spyOn(storageOwner, "run").mockImplementation((name, args) => owner.run(name, args));
    sent.length = 0;
    try {
      const { registerPostHandlers } = await import("@main/ipc/posts.js");
      const { CHANNELS } = await import("@shared/ipc");
      registerPostHandlers();
      owner.onHeldEditFailed((storageOwner as unknown as { heldFailureListener: Parameters<StorageOwner["onHeldEditFailed"]>[0] }).heldFailureListener);
      const slow = owner.run("getUiState", [], 10).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10);
      await slow;
      // Answered as buffered while held.
      expect(await handlers.get(CHANNELS.queuePostMetadata)!({}, "workspace-id", "post", { slug: "taken" })).toBeNull();
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
      const refusal = { key: "metadata.refusedSlugTaken", values: { slug: "taken" } };
      worker.emit("message", { id: worker.requests[1].id, ok: true, value: refusal });
      expect(sent.filter((item) => item.channel === CHANNELS.postMetadataRefused).map((item) => item.payload))
        .toEqual([{ postId: "post", edits: { slug: "taken" }, refusal }]);
    } finally { run.mockRestore(); await owner.stop(); }
  });

  it("flushes a newer edit arriving during the first quit flush within the same deadline", async () => {
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    const ports: StorageFlushRequest[] = [];
    try {
      const started = owner.run("queueContent", ["/workspace", "post", "first"]);
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: undefined });
      await started;
      const flushing = owner.flushAsync(1000);
      const first = worker.requests[1] as unknown as StorageFlushRequest;
      ports.push(first);
      await expect(owner.run("queueContent", ["/workspace", "post", "during flush"])).rejects.toBeInstanceOf(EditPendingError);
      worker.emit("message", { event: "flush-settled" });
      first.port.postMessage({ failures: [] });
      // The held edit is delivered as storage frees, then a second flush writes it.
      await vi.waitFor(() => expect(worker.requests).toHaveLength(4));
      expect(worker.requests[2]).toMatchObject({ name: "queueContent", args: ["/workspace", "post", "during flush"] });
      const second = worker.requests[3] as unknown as StorageFlushRequest;
      ports.push(second);
      expect(second.flush).toBe(true);
      worker.emit("message", { id: worker.requests[2].id, ok: true, value: undefined });
      worker.emit("message", { event: "flush-settled" });
      second.port.postMessage({ failures: [] });
      expect(await flushing).toEqual({ kind: "flushed", failures: [] });
    } finally { for (const request of ports) request.port.close(); await owner.stop(); }
  });

  it("reports whether the worker finished within the exit bound", async () => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    try {
      const started = owner.run("getUiState", []);
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
      await started;
      const finishing = owner.finishAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await finishing).toBe(false);
    } finally { await owner.stop(); }
    expect(await new StorageOwner(() => new HeldWorker() as unknown as Worker).finishAsync(1000)).toBe(true);
  });
});

it("runs real store writes and quit flush on the persistent worker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-storage-owner-"));
  let owner: StorageOwner | undefined;
  try {
    const entry = path.join(root, "worker.cjs");
    await build({ entryPoints: [path.resolve("src/main/storageWorker.ts")], outfile: entry, bundle: true, platform: "node", format: "cjs", alias: { "@shared": path.resolve("src/shared") } });
    owner = new StorageOwner(() => new Worker(entry, { env: { ...process.env, BIGMOUTH_DATA_DIR: root } }));
    await owner.run("initialize", []);
    const workspace = await owner.run("openOrCreateWorkspace", ["Test"]);
    await owner.run("saveTargets", [workspace.dataDirectory, [{ name: "blog", defaultLanguage: "en", requiresMetadata: false }]]);
    const post = await owner.run("createPost", [workspace.dataDirectory, "blog", "en"]);
    const authored = new Date(new Date(post.frontMatter.createdAtUtc).getTime() + 1);
    await owner.run("queueContent", [workspace.dataDirectory, post.frontMatter.id, "written by the worker", authored]);
    expect(await owner.flushAsync(2000)).toEqual({ kind: "flushed", failures: [] });
    const raw = fs.readFileSync(post.filePath, "utf8");
    expect(raw).toContain("written by the worker");
    expect(raw).toContain(authored.toISOString());

    // Locking before the debounce writes the buffered text with the lock, so
    // the quit that follows has nothing left to save and reports nothing.
    await owner.run("resumePendingFlushes", []);
    await owner.run("queueContent", [workspace.dataDirectory, post.frontMatter.id, "locked before autosave"]);
    await owner.run("setLocked", [workspace.dataDirectory, post.frontMatter.id, true]);
    expect(await owner.flushAsync(2000)).toEqual({ kind: "flushed", failures: [] });
    expect(fs.readFileSync(post.filePath, "utf8")).toContain("locked before autosave");

    // An edit buffered after the last quit flush, as while the quit question
    // is open, is written by the finish step.
    const late = await owner.run("createPost", [workspace.dataDirectory, "blog", "en"]);
    await owner.run("queueContent", [workspace.dataDirectory, late.frontMatter.id, "typed during the question"]);
    expect(await owner.finishAsync(1000)).toBe(true);
    expect(fs.readFileSync(late.filePath, "utf8")).toContain("typed during the question");
  } finally { await owner?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
