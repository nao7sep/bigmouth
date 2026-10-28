import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { build } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKER_ENTRIES } from "@main/builtEntries.js";
import { EditPendingError, StorageOwner, type StorageRequest, type StorageFlushRequest, type WorkspaceContentSaveEvent, storageOwner } from "@main/storageOwner.js";

const EDITED_AT = new Date("2026-10-23T00:00:00.000Z");

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

describe("storage records notifications", () => {
  it("retains records health and notifies listeners from worker events", async () => {
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    const health = vi.fn();
    owner.onRecordsHealth(health);
    expect(owner.recordsHealth()).toEqual({ databaseGap: false, fallbackFailed: false, fallbackPath: null });
    try {
      const started = owner.run("getUiState", []);
      const failure = { databaseGap: true, fallbackFailed: true, fallbackPath: "/fallback.jsonl" };
      worker.emit("message", { event: "records-health", value: failure });
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
      await started;
      expect(health).toHaveBeenCalledExactlyOnceWith(failure);
      expect(owner.recordsHealth()).toEqual(failure);
      // Neither a consumer nor a listener owns the retained health object.
      owner.recordsHealth().databaseGap = false;
      health.mock.calls[0][0].fallbackFailed = false;
      expect(owner.recordsHealth()).toEqual(failure);
      owner.onRecordsHealth(null);
      worker.emit("message", { event: "records-health", value: failure });
      expect(health).toHaveBeenCalledTimes(1);
    } finally { await owner.stop(); }
  });
});

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

  it.each(["success", "failure"] as const)("retains a started post creation through delayed %s settlement", async (outcome) => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    const pending: boolean[] = [];
    owner.onStoragePending((value) => pending.push(value));
    const completed = vi.fn();
    try {
      const result = owner.run("createPost", ["/workspace", "blog", "en"], 10).then(completed, completed);
      await vi.advanceTimersByTimeAsync(10);
      expect(completed).not.toHaveBeenCalled();
      expect(owner.storagePending()).toBe(true);
      expect(pending).toEqual([true]);
      await expect(owner.run("createPost", ["/workspace", "blog", "en"])).rejects.toThrow("previous operation settles");
      expect(worker.requests).toHaveLength(1);
      worker.emit("message", outcome === "success"
        ? { id: worker.requests[0].id, ok: true, value: { frontMatter: { id: "created-once" } } }
        : { id: worker.requests[0].id, ok: false, error: { name: "Error", message: "primary publication failed" } });
      await result;
      expect(completed).toHaveBeenCalledTimes(1);
      expect(completed.mock.calls[0][0]).toEqual(outcome === "success"
        ? { frontMatter: { id: "created-once" } }
        : expect.objectContaining({ message: "primary publication failed" }));
      expect(owner.storagePending()).toBe(false);
      expect(pending).toEqual([true, false]);
    } finally { await owner.stop(); }
  });

  it("settles a pending mutation and clears pending status when its worker fails", async () => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    const pending: boolean[] = [];
    owner.onStoragePending((value) => pending.push(value));
    try {
      const mutation = owner.run("createPost", ["/workspace", "blog", "en"], 10).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      worker.emit("error", new Error("worker failed"));
      expect(await mutation).toEqual(expect.objectContaining({ message: "worker failed" }));
      expect(pending).toEqual([true, false]);
      expect(owner.storagePending()).toBe(false);
    } finally { await owner.stop(); }
  });

  it("reports every retained held edit once when the worker crashes, after releasing ownership", async () => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    const failure = new Error("worker crashed");
    const failed = vi.fn((request: StorageRequest) => {
      expect(owner.holdsContentFor(request.args[0] as string, request.args[1] as string)).toBe(false);
    });
    owner.onHeldEditFailed(failed);
    try {
      const read = owner.run("getUiState", [], 10).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10);
      await read;
      await expect(owner.run("queueWorkspaceContent", ["/workspace", "post", "older text", EDITED_AT])).rejects.toBeInstanceOf(EditPendingError);
      await expect(owner.run("queueWorkspaceMetadata", ["/workspace", "post", { title: "first" }, EDITED_AT])).rejects.toBeInstanceOf(EditPendingError);
      await expect(owner.run("queueWorkspaceContent", ["/workspace", "post", "latest text", EDITED_AT])).rejects.toBeInstanceOf(EditPendingError);
      await expect(owner.run("queueWorkspaceMetadata", ["/workspace", "post", { title: "second" }, EDITED_AT])).rejects.toBeInstanceOf(EditPendingError);
      worker.emit("error", failure);
      worker.emit("exit", 1);
      await owner.stop();
      expect(failed.mock.calls.map(([request]) => request.args[2])).toEqual([
        { title: "first" }, "latest text", { title: "second" },
      ]);
      for (const call of failed.mock.calls) expect(call).toEqual([expect.any(Object), failure]);
      expect(vi.getTimerCount()).toBe(0);
      expect(worker.requests).toHaveLength(1);
    } finally { await owner.stop(); }
  });

  it.each(["active", "queued", "delivering"] as const)(
    "reports an expired %s authored edit once when its worker crashes",
    async (location) => {
      vi.useFakeTimers();
      const worker = new HeldWorker();
      const owner = new StorageOwner(() => worker as unknown as Worker);
      const failed = vi.fn();
      owner.onHeldEditFailed(failed);
      let flush: StorageFlushRequest | undefined;
      try {
        if (location !== "active") void owner.run("getUiState", [], 1000).catch(() => undefined);
        const content = owner.run("queueWorkspaceContent", ["/workspace", "post", "pending text", EDITED_AT], 10).catch((error: unknown) => error);
        const metadata = owner.run("queueWorkspaceMetadata", ["/workspace", "post", { title: "pending title" }, EDITED_AT], 10).catch((error: unknown) => error);
        if (location === "delivering") {
          expect(owner.flushWithin(0)).toEqual({ kind: "expired" });
          flush = worker.requests.at(-1) as unknown as StorageFlushRequest;
          expect(flush.edits).toHaveLength(2);
        }
        await vi.advanceTimersByTimeAsync(10);
        expect(await content).toBeInstanceOf(EditPendingError);
        expect(await metadata).toBeInstanceOf(EditPendingError);
        const error = new Error("worker crashed");
        worker.emit("error", error);
        worker.emit("exit", 1);
        expect(failed.mock.calls).toEqual([
          [expect.objectContaining({ name: "queueWorkspaceContent" }), error],
          [expect.objectContaining({ name: "queueWorkspaceMetadata" }), error],
        ]);
        expect(owner.holdsContentFor("/workspace", "post")).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      } finally { flush?.port.close(); await owner.stop(); }
    },
  );

  it("rejects unexpired authored requests through their original caller without a second failure notification", async () => {
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    const failed = vi.fn();
    owner.onHeldEditFailed(failed);
    try {
      const content = owner.run("queueWorkspaceContent", ["/workspace", "post", "pending text", EDITED_AT]).catch((error: unknown) => error);
      const metadata = owner.run("queueWorkspaceMetadata", ["/workspace", "post", { title: "pending title" }, EDITED_AT]).catch((error: unknown) => error);
      const error = new Error("worker crashed");
      worker.emit("error", error);
      worker.emit("exit", 1);
      expect(await content).toBe(error);
      expect(await metadata).toBe(error);
      expect(failed).not.toHaveBeenCalled();
    } finally { await owner.stop(); }
  });

  // A hand-off that cannot be read must not leave its request, or storage, waiting forever.
  it("fails a request the worker could not read as not done, and moves on", async () => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    const pending: boolean[] = [];
    owner.onStoragePending((value) => pending.push(value));
    try {
      const mutation = owner.run("createPost", ["/workspace", "blog", "en"], 10).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      worker.emit("message", { event: "request-unreadable" });
      expect(await mutation).toEqual(expect.objectContaining({ message: expect.stringContaining("Nothing was done") }));
      expect(pending).toEqual([true, false]);
      expect(owner.storagePending()).toBe(false);
      const next = owner.run("getUiState", []).catch((error: unknown) => error);
      expect(worker.requests).toHaveLength(2);
      worker.emit("message", { id: worker.requests[1].id, ok: true, value: { zoomLevel: 1 } });
      expect(await next).toEqual({ zoomLevel: 1 });
    } finally { await owner.stop(); }
  });

  it("fails a request whose reply could not be read with its outcome unknown, and moves on", async () => {
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    try {
      const mutation = owner.run("installAsset", ["/workspace", "post", "a.png", { name: "a.part", sha256: "00", size: 1 }, { filename: "a.png", size: 1 }]).catch((error: unknown) => error);
      worker.emit("messageerror", new Error("Unable to deserialize cloned data."));
      expect(await mutation).toEqual(expect.objectContaining({ message: expect.stringContaining("Whether it took effect is unknown") }));
      const next = owner.run("getUiState", []);
      worker.emit("message", { id: worker.requests[1].id, ok: true, value: {} });
      await expect(next).resolves.toEqual({});
    } finally { await owner.stop(); }
  });

  it("expires a queued creation before it starts without issuing the effect", async () => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    try {
      const read = owner.run("getUiState", [], 1000).catch(() => undefined);
      const queued = owner.run("createPost", ["/workspace", "blog", "en"], 10).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      expect(await queued).toEqual(expect.objectContaining({ message: expect.stringContaining("did not start") }));
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
      await read;
      expect(worker.requests).toHaveLength(1);
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
      await expect(owner.run("queueWorkspaceContent", ["/workspace", "post", "typed while blocked", EDITED_AT])).rejects.toBeInstanceOf(EditPendingError);
      expect(worker.requests).toHaveLength(1);
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
      expect(worker.requests[1]).toMatchObject({ name: "queueWorkspaceContent", args: ["/workspace", "post", "typed while blocked", EDITED_AT] });
    } finally { await owner.stop(); }
  });

  it("keeps an edit whose wait expires in its queue position, ahead of a later lock", async () => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    try {
      const read = owner.run("getUiState", [], 1000).catch(() => undefined);
      const edit = owner.run("queueWorkspaceContent", ["/workspace", "post", "queued behind a read", EDITED_AT], 10).catch((error: unknown) => error);
      const lock = owner.run("setLocked", ["/workspace", "post", true], 1000).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10);
      expect(await edit).toBeInstanceOf(EditPendingError);
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
      await read;
      expect(worker.requests[1]).toMatchObject({ name: "queueWorkspaceContent", args: ["/workspace", "post", "queued behind a read", EDITED_AT] });
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
        () => owner.run("queueWorkspaceMetadata", ["/workspace", "post", { title: "first", slug: "kept" }, EDITED_AT]),
        () => owner.run("queueWorkspaceContent", ["/workspace", "post", "older text", EDITED_AT]),
        () => owner.run("queueWorkspaceMetadata", ["/workspace", "post", { title: "second" }, EDITED_AT]),
        () => owner.run("queueWorkspaceContent", ["/workspace", "post", "newest text", EDITED_AT]),
        () => owner.run("queueWorkspaceMetadata", ["/workspace", "post", { title: "third" }, EDITED_AT]),
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
      const edit = owner.run("queueWorkspaceContent", ["/workspace", "post", "accepted", EDITED_AT]);
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
      await expect(owner.run("queueWorkspaceContent", ["/workspace", "post", "held", EDITED_AT])).rejects.toBeInstanceOf(EditPendingError);
      expect(owner.holdsContentFor("/workspace", "post")).toBe(true);
      expect(owner.holdsContentFor("another-workspace", "post")).toBe(false);
      expect(owner.holdsContentFor("/workspace", "other")).toBe(false);
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
      // Sent, but the worker has not replied: still on this side.
      expect(worker.requests[1].name).toBe("queueWorkspaceContent");
      expect(owner.holdsContentFor("/workspace", "post")).toBe(true);
      expect(owner.holdsContentFor("another-workspace", "post")).toBe(false);
      worker.emit("message", { id: worker.requests[1].id, ok: true, value: undefined });
      expect(owner.holdsContentFor("/workspace", "post")).toBe(false);
    } finally { await owner.stop(); }
  });

  it("marks a save as not the latest while newer text for the post is held", async () => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    const run = vi.spyOn(storageOwner, "run").mockImplementation((name, args) => owner.run(name, args));
    const holds = vi.spyOn(storageOwner, "holdsContentFor").mockImplementation((wsId, id) => owner.holdsContentFor(wsId, id));
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
      worker.emit("message", { event: "content-save", value: { wsId: "workspace-id", kind: "saved", dataDir: "/d", id: "post", summary } });
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
      worker.emit("message", { id: worker.requests[1].id, ok: true, value: undefined });
      worker.emit("message", { event: "content-save", value: { wsId: "workspace-id", kind: "saved", dataDir: "/d", id: "post", summary } });
      expect(sent.filter((item) => item.channel === CHANNELS.postContentSaved).map((item) => item.payload))
        .toEqual([{ wsId: "workspace-id", postId: "post", summary, newerEditHeld: true }, { wsId: "workspace-id", postId: "post", summary, newerEditHeld: false }]);
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
        .toEqual([{ wsId: "workspace-id", postId: "post", edits: { slug: "taken" }, refusal }]);
    } finally { run.mockRestore(); await owner.stop(); }
  });

  it("flushes a newer edit arriving during the first quit flush within the same deadline", async () => {
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    const ports: StorageFlushRequest[] = [];
    try {
      const started = owner.run("queueWorkspaceContent", ["/workspace", "post", "first", EDITED_AT]);
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: undefined });
      await started;
      const flushing = owner.flushAsync(1000);
      const first = worker.requests[1] as unknown as StorageFlushRequest;
      ports.push(first);
      await expect(owner.run("queueWorkspaceContent", ["/workspace", "post", "during flush", EDITED_AT])).rejects.toBeInstanceOf(EditPendingError);
      worker.emit("message", { event: "flush-settled" });
      first.port.postMessage({ failures: [] });
      // The held edit is delivered as storage frees, then a second flush writes it.
      await vi.waitFor(() => expect(worker.requests).toHaveLength(4));
      expect(worker.requests[2]).toMatchObject({ name: "queueWorkspaceContent", args: ["/workspace", "post", "during flush", EDITED_AT] });
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
      const finishing = owner.finishAsync(1000, 0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await finishing).toBe(false);
    } finally { await owner.stop(); }
    expect(await new StorageOwner(() => new HeldWorker() as unknown as Worker).finishAsync(1000, 0)).toBe(true);
  });
});

it.each(["async", "session-end"] as const)("runs real store writes and %s quit flush on the persistent worker", async (mode) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-storage-owner-"));
  let owner: StorageOwner | undefined;
  try {
    const outDir = path.join(root, "worker");
    const entry = path.join(outDir, `${WORKER_ENTRIES.storage}.js`);
    // Standalone bundles, dependencies included, with the backup recorder beside
    // the storage worker as in out/main, so the worker runs from the temporary
    // folder the way the built app runs it.
    await build({
      configFile: false,
      logLevel: "silent",
      resolve: { alias: { "@shared": path.resolve("src/shared") } },
      ssr: { noExternal: true },
      build: {
        ssr: true,
        outDir,
        minify: false,
        rolldownOptions: {
          input: {
            [WORKER_ENTRIES.storage]: path.resolve("src/main/storageWorker.ts"),
            [WORKER_ENTRIES.backup]: path.resolve("src/main/core/services/backupWorker.ts"),
          },
          output: { format: "cjs", entryFileNames: "[name].js" },
        },
      },
    });
    owner = new StorageOwner(() => new Worker(entry, { env: { ...process.env, BIGMOUTH_DATA_DIR: root } }));
    await owner.run("initialize", []);
    const saveEvents: WorkspaceContentSaveEvent[] = [];
    owner.onContentSave((event) => saveEvents.push(event));
    const workspace = await owner.run("createWorkspace", ["Test"]);
    await owner.run("saveTargets", [workspace.dataDirectory, [{ name: "blog", defaultLanguage: "en", requiresMetadata: false }]]);
    const post = await owner.run("createPost", [workspace.dataDirectory, "blog", "en"]);
    const authored = new Date(new Date(post.frontMatter.createdAtUtc).getTime() + 1);
    await owner.run("queueWorkspaceContent", [workspace.id, post.frontMatter.id, "written by the worker", authored]);
    expect(mode === "async" ? await owner.flushAsync(2000) : owner.flushWithin(2000)).toEqual({ kind: "flushed", failures: [] });
    const raw = fs.readFileSync(post.filePath, "utf8");
    expect(raw).toContain("written by the worker");
    expect(raw).toContain(authored.toISOString());

    // Locking before the debounce writes the buffered text with the lock, so
    // the quit that follows has nothing left to save and reports nothing.
    await owner.run("resumePendingFlushes", []);
    // Copying a post into another workspace preserves its id. Worker events
    // still identify which physical copy was saved.
    const secondWorkspace = await owner.run("createWorkspace", ["Second", path.join(root, "second-workspace")]);
    const copiedFile = path.join(secondWorkspace.dataDirectory, path.relative(workspace.dataDirectory, post.filePath));
    fs.mkdirSync(path.dirname(copiedFile), { recursive: true });
    fs.copyFileSync(post.filePath, copiedFile);
    await owner.run("refreshIndex", [secondWorkspace.dataDirectory]);
    const savedBeforeCopies = saveEvents.length;
    await owner.run("queueWorkspaceContent", [workspace.id, post.frontMatter.id, "first workspace copy", new Date()]);
    await owner.run("queueWorkspaceContent", [secondWorkspace.id, post.frontMatter.id, "second workspace copy", new Date()]);
    expect(mode === "async" ? await owner.flushAsync(2000) : owner.flushWithin(2000)).toEqual({ kind: "flushed", failures: [] });
    // Synchronous flush events are delivered on the next event-loop turn.
    await owner.run("resumePendingFlushes", []);
    expect(saveEvents.slice(savedBeforeCopies).filter((event) => event.kind === "saved").map((event) => [event.wsId, event.id])).toEqual([
      [workspace.id, post.frontMatter.id], [secondWorkspace.id, post.frontMatter.id],
    ]);
    expect(fs.readFileSync(post.filePath, "utf8")).toContain("first workspace copy");
    expect(fs.readFileSync(copiedFile, "utf8")).toContain("second workspace copy");
    await owner.run("queueWorkspaceContent", [workspace.id, post.frontMatter.id, "locked before autosave", new Date()]);
    await owner.run("setLocked", [workspace.dataDirectory, post.frontMatter.id, true]);
    const late = await owner.run("createPost", [workspace.dataDirectory, "blog", "en"]);
    expect(mode === "async" ? await owner.flushAsync(2000) : owner.flushWithin(2000)).toEqual({ kind: "flushed", failures: [] });
    expect(fs.readFileSync(post.filePath, "utf8")).toContain("locked before autosave");

    // An edit buffered after the last quit flush, as while the quit question
    // is open, is written by the finish step.
    const lateEdit = owner.run("queueWorkspaceContent", [workspace.id, late.frontMatter.id, "typed during the question", new Date()]);
    // The synchronous flush has not yielded to its settlement event yet.
    // Finish must take ownership of an edit still held on the main thread too.
    if (mode === "session-end") await expect(lateEdit).rejects.toBeInstanceOf(EditPendingError);
    else await lateEdit;
    expect(mode === "async" ? await owner.finishAsync(1000, 0) : owner.finishWithin(1000)).toBe(true);
    expect(fs.readFileSync(late.filePath, "utf8")).toContain("typed during the question");
  } finally { await owner?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

it("returns from synchronous session-end bounds while a real worker remains stalled", async () => {
  // A real worker answers startup but never settles flush/finish. The main
  // thread must return from its Atomics wait without an event-loop callback.
  const owner = new StorageOwner(() => new Worker(`
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", (request) => {
      if (request.id) parentPort.postMessage({ id: request.id, ok: true, value: {} });
    });
  `, { eval: true }));
  try {
    await owner.run("getUiState", []);
    expect(owner.flushWithin(10)).toEqual({ kind: "expired" });
    expect(owner.finishWithin(10)).toBe(false);
  } finally { await owner.stop(); }
});
