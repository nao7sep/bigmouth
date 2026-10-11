import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditPendingError, STORAGE_WAIT_MS, StorageOwner, type StorageRequest } from "@main/storageOwner.js";

class HeldWorker extends EventEmitter {
  requests: StorageRequest[] = [];
  unref(): void {}
  postMessage(request: StorageRequest): void { this.requests.push(request); }
  async terminate(): Promise<number> { return 0; }
}

afterEach(() => vi.useRealTimers());

describe("authored edits settling after their caller stopped waiting", () => {
  it.each(["active", "queued", "held"] as const)("reports a late metadata refusal for an %s edit exactly once", async (placement) => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    const failed = vi.fn();
    owner.onHeldEditFailed(failed);
    try {
      let read: Promise<unknown> | undefined;
      if (placement !== "active") read = owner.run("getUiState", [], 10).catch(() => undefined);
      if (placement === "held") await vi.advanceTimersByTimeAsync(10);
      const edit = owner.run("queueWorkspaceMetadata", ["workspace", "post", { slug: "taken" }, new Date()], 10).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      expect(await edit).toBeInstanceOf(EditPendingError);
      if (placement !== "active") {
        worker.emit("message", { id: worker.requests[0].id, ok: true, value: {} });
        await read;
      }
      // A held delivery has its own wait; expiry cannot discard its real result either.
      if (placement === "held") await vi.advanceTimersByTimeAsync(STORAGE_WAIT_MS);
      const request = worker.requests.at(-1)!;
      const refusal = { key: "metadata.refusedSlugTaken", values: { slug: "taken" } };
      const reply = { id: request.id, ok: true, value: refusal };
      worker.emit("message", reply);
      worker.emit("message", reply);
      expect(failed).toHaveBeenCalledExactlyOnceWith(request, refusal);
    } finally { await owner.stop(); }
  });

  it("reports a late storage exception but does not report accepted metadata as a failure", async () => {
    vi.useFakeTimers();
    const worker = new HeldWorker();
    const owner = new StorageOwner(() => worker as unknown as Worker);
    const failed = vi.fn();
    owner.onHeldEditFailed(failed);
    try {
      const edit = owner.run("queueWorkspaceContent", ["workspace", "post", "draft", new Date()], 10).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10);
      await edit;
      worker.emit("message", { id: worker.requests[0].id, ok: false, error: { name: "Error", message: "workspace unavailable" } });
      expect(failed).toHaveBeenCalledExactlyOnceWith(worker.requests[0], expect.objectContaining({ message: "workspace unavailable" }));
      const metadata = owner.run("queueWorkspaceMetadata", ["workspace", "post", { title: "kept" }, new Date()], 10).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10);
      await metadata;
      worker.emit("message", { id: worker.requests[1].id, ok: true, value: null });
      expect(failed).toHaveBeenCalledTimes(1);
    } finally { await owner.stop(); }
  });
});
