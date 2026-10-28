import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { build } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKER_ENTRIES } from "@main/builtEntries.js";
import { StorageOwner, type StorageRequest, type StorageFinishRequest, type WorkspaceContentSaveEvent } from "@main/storageOwner.js";

const EDITED_AT = new Date("2026-10-23T00:00:00.000Z");

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

describe("storage command order", () => {
  it("runs one command at a time, in order, each waiting its turn with no deadline", async () => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    try {
      const first = owner.run("getUiState", []);
      const second = owner.run("createPost", ["/workspace", "blog", "en"]);
      const edit = owner.run("queueWorkspaceContent", ["ws", "post", "text", EDITED_AT]);
      // Local storage gets no timeout: however long the first command takes,
      // the others wait behind it and nothing fails meanwhile.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.getTimerCount()).toBe(0);
      expect(worker.requests.map((request) => request.name)).toEqual(["getUiState"]);
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: { zoomLevel: 1 } });
      expect(await first).toEqual({ zoomLevel: 1 });
      expect(worker.requests.map((request) => request.name)).toEqual(["getUiState", "createPost"]);
      worker.emit("message", { id: worker.requests[1].id, ok: false, error: { name: "Error", message: "refused" } });
      await expect(second).rejects.toThrow("refused");
      expect(worker.requests[2]).toEqual(expect.objectContaining({ name: "queueWorkspaceContent", args: ["ws", "post", "text", EDITED_AT] }));
      worker.emit("message", { id: worker.requests[2].id, ok: true, value: undefined });
      await expect(edit).resolves.toBeUndefined();
    } finally { await owner.stop(); }
  });

  it("fails every waiting caller once when its worker fails, and refuses later commands", async () => {
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    try {
      const content = owner.run("queueWorkspaceContent", ["/workspace", "post", "pending text", EDITED_AT]).catch((error: unknown) => error);
      const metadata = owner.run("queueWorkspaceMetadata", ["/workspace", "post", { title: "pending title" }, EDITED_AT]).catch((error: unknown) => error);
      const error = new Error("worker crashed");
      worker.emit("error", error);
      worker.emit("exit", 1);
      expect(await content).toBe(error);
      expect(await metadata).toBe(error);
      await expect(owner.run("getUiState", [])).rejects.toThrow("Storage is unavailable.");
    } finally { await owner.stop(); }
  });

  // A hand-off that cannot be read must not leave its request, or storage, waiting forever.
  it("fails a request the worker could not read as not done, and moves on", async () => {
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    try {
      const mutation = owner.run("createPost", ["/workspace", "blog", "en"]).catch((error: unknown) => error);
      const next = owner.run("getUiState", []).catch((error: unknown) => error);
      worker.emit("message", { event: "request-unreadable" });
      expect(await mutation).toEqual(expect.objectContaining({ message: expect.stringContaining("Nothing was done") }));
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

  it("finishes with everything still queued, routes their replies, and refuses commands after", async () => {
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    try {
      const active = owner.run("getUiState", []);
      const queued = owner.run("queueWorkspaceContent", ["ws", "post", "typed during the question", EDITED_AT]);
      const finishing = owner.finishAsync(1000, 0);
      const finish = worker.requests.at(-1) as unknown as StorageFinishRequest;
      expect(finish.queued.map((request) => request.name)).toEqual(["queueWorkspaceContent"]);
      await expect(owner.run("getUiState", [])).rejects.toThrow("Storage is closing.");
      worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
      worker.emit("message", { id: finish.queued[0].id, ok: true, value: undefined });
      await expect(active).resolves.toEqual({});
      await expect(queued).resolves.toBeUndefined();
      finish.port.postMessage({ finished: true });
      expect(await finishing).toBe(true);
    } finally { await owner.stop(); }
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

it.each(["async", "session-end"] as const)("runs real store writes, the quit flush and %s finish on the persistent worker", async (mode) => {
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
    expect(await owner.run("flush", [])).toEqual([]);
    const raw = fs.readFileSync(post.filePath, "utf8");
    expect(raw).toContain("written by the worker");
    expect(raw).toContain(authored.toISOString());

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
    expect(await owner.run("flush", [])).toEqual([]);
    expect(saveEvents.slice(savedBeforeCopies).filter((event) => event.kind === "saved").map((event) => [event.wsId, event.id])).toEqual([
      [workspace.id, post.frontMatter.id], [secondWorkspace.id, post.frontMatter.id],
    ]);
    expect(fs.readFileSync(post.filePath, "utf8")).toContain("first workspace copy");
    expect(fs.readFileSync(copiedFile, "utf8")).toContain("second workspace copy");
    // Locking before the debounce writes the buffered text with the lock, so
    // the quit that follows has nothing left to save and reports nothing.
    await owner.run("queueWorkspaceContent", [workspace.id, post.frontMatter.id, "locked before autosave", new Date()]);
    await owner.run("setLocked", [workspace.dataDirectory, post.frontMatter.id, true]);
    const late = await owner.run("createPost", [workspace.dataDirectory, "blog", "en"]);
    expect(await owner.run("flush", [])).toEqual([]);
    expect(fs.readFileSync(post.filePath, "utf8")).toContain("locked before autosave");

    // An edit buffered after the last quit flush, as while the quit question
    // is open, is written by the finish step.
    // In the synchronous mode it is still queued on this side when finish takes it.
    const lateEdit = owner.run("queueWorkspaceContent", [workspace.id, late.frontMatter.id, "typed during the question", new Date()]);
    if (mode === "async") await lateEdit;
    expect(mode === "async" ? await owner.finishAsync(5000, 0) : owner.finishWithin(5000)).toBe(true);
    await lateEdit;
    expect(fs.readFileSync(late.filePath, "utf8")).toContain("typed during the question");
  } finally { await owner?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

it("returns from the synchronous session-end bound while a real worker remains stalled", async () => {
  // A real worker answers startup but never settles finish. The main thread
  // must return from its Atomics wait, which no fake clock can drive, without
  // an event-loop callback.
  const owner = new StorageOwner(() => new Worker(`
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", (request) => {
      if (request.id) parentPort.postMessage({ id: request.id, ok: true, value: {} });
    });
  `, { eval: true }));
  try {
    await owner.run("getUiState", []);
    expect(owner.finishWithin(10)).toBe(false);
  } finally { await owner.stop(); }
});
