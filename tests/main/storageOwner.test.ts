import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageOwner, type StorageRequest, type StorageFlushRequest, storageOwner } from "@main/storageOwner.js";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({ ipcMain: {
  on: (channel: string, callback: (...args: unknown[]) => unknown) => handlers.set(channel, callback),
  handle: (channel: string, callback: (...args: unknown[]) => unknown) => handlers.set(channel, callback),
}, BrowserWindow: { getAllWindows: () => [] } }));

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

  it("retains rejected authored packets and includes them when cancelling a pending quit", async () => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    try {
      const held = owner.run("getUiState", [], 10).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10);
      await held;
      await expect(owner.run("queueContent", ["/workspace", "post", "typed while blocked"])).rejects.toThrow();
      const resume = owner.run("resumePendingFlushes", []);
      expect(worker.requests).toHaveLength(1);
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
      expect(worker.requests[1].edits).toEqual([expect.objectContaining({ name: "queueContent", args: ["/workspace", "post", "typed while blocked"] })]);
      worker.emit("message", { id: worker.requests[1].id, ok: true, value: undefined });
      await resume;
      expect(owner.pendingEditIds()).toEqual(["post"]);
    } finally { await owner.stop(); }
  });

  it("captures the real IPC packet and authored instant before a held storage read settles", async () => {
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
      const content = handlers.get(CHANNELS.queuePostContent)!({}, "workspace-id", "post", "newest text");
      expect(owner.pendingEditIds()).toEqual(["post"]);
      await content;
      const resume = owner.run("resumePendingFlushes", []);
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
      const packet = worker.requests[1].edits![0];
      expect(packet.name).toBe("queueWorkspaceContent");
      expect(packet.args).toEqual(["workspace-id", "post", "newest text", new Date(authored)]);
      worker.emit("message", { id: worker.requests[1].id, ok: true, value: undefined });
      await resume;
    } finally { spy.mockRestore(); await owner.stop(); }
  });

  it("flushes a newer packet arriving during the first quit flush within the same deadline", async () => {
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    const ports: StorageFlushRequest[] = [];
    try {
      const first = owner.run("queueContent", ["/workspace", "post", "first"]);
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: undefined });
      await first;
      const flushing = owner.flushAsync(1000);
      const old = worker.requests[1] as unknown as StorageFlushRequest;
      ports.push(old);
      await expect(owner.run("queueContent", ["/workspace", "post", "during flush"])).rejects.toThrow();
      worker.emit("message", { event: "content-save", sequence: old.edits[0].id, value: { kind: "saved", dataDir: "/workspace", id: "post", summary: {} } });
      worker.emit("message", { event: "flush-settled" });
      old.port.postMessage({ failures: [] });
      await vi.waitFor(() => expect(worker.requests).toHaveLength(3));
      const latest = worker.requests[2] as unknown as StorageFlushRequest;
      ports.push(latest);
      expect(latest.edits[0].args[2]).toBe("during flush");
      worker.emit("message", { event: "content-save", sequence: latest.edits[0].id, value: { kind: "saved", dataDir: "/workspace", id: "post", summary: {} } });
      worker.emit("message", { event: "flush-settled" });
      latest.port.postMessage({ failures: [] });
      expect(await flushing).toEqual({ kind: "flushed", failures: [] });
      expect(owner.pendingEditIds()).toEqual([]);
    } finally { for (const request of ports) request.port.close(); await owner.stop(); }
  });

  it("keeps newer authored packets when an older authoritative save arrives", async () => {
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    try {
      const first = owner.run("queueContent", ["/workspace", "post", "first"]);
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: undefined });
      await first;
      const next = owner.run("queueContent", ["/workspace", "post", "newer"]);
      worker.emit("message", { event: "content-save", sequence: worker.requests[0].id, value: { kind: "saved", dataDir: "/workspace", id: "post", summary: {} } });
      expect(owner.pendingEditIds()).toEqual(["post"]);
      worker.emit("message", { id: worker.requests[1].id, ok: true, value: undefined });
      await next;
      expect(owner.pendingEditIds()).toEqual(["post"]);
      worker.emit("message", { event: "content-save", sequence: worker.requests[1].id, value: { kind: "saved", dataDir: "/workspace", id: "post", summary: {} } });
      expect(owner.pendingEditIds()).toEqual([]);
    } finally { await owner.stop(); }
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
    expect(owner.pendingEditIds()).toEqual([post.frontMatter.id]);
    expect(await owner.flushAsync(2000)).toEqual({ kind: "flushed", failures: [] });
    const raw = fs.readFileSync(post.filePath, "utf8");
    expect(raw).toContain("written by the worker");
    expect(raw).toContain(authored.toISOString());
    await owner.finishAsync(1000);
  } finally { await owner?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
