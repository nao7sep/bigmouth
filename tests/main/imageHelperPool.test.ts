import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IMAGE_IDLE_MS, ImageHelperPool, type ImageJob, type ImagePoolOptions, type ImageProcess } from "@main/imageHelperPool.js";

class FakeImageProcess extends EventEmitter implements ImageProcess {
  readonly postMessage = vi.fn<(job: ImageJob | { type: "retire" }) => void>();
  readonly kill = vi.fn(() => true);
  exited = false;
  get job(): ImageJob { return this.postMessage.mock.calls[0][0] as ImageJob; }
  result(): void { this.emit("message", { type: "result", outcome: { kind: "generated" } }); }
  exit(): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", 0);
  }
}

const fixtures: { pool: ImageHelperPool; children: FakeImageProcess[]; cleanups: { resolve: () => void }[] }[] = [];
function harness(options: Pick<ImagePoolOptions, "pendingBytes"> & { stageOwned?: boolean } = {}) {
  const { stageOwned = true, ...poolOptions } = options;
  const children: FakeImageProcess[] = [];
  const cleanups: { directory: string; resolve: () => void }[] = [];
  const cleanup = vi.fn((directory: string) => new Promise<void>((resolve) => cleanups.push({ directory, resolve })));
  const pool = new ImageHelperPool({ capacity: 2, ...poolOptions, cleanup, create: () => {
    const child = new FakeImageProcess();
    child.postMessage.mockImplementation((job) => {
      if (stageOwned && !("type" in job)) child.emit("message", { type: "stage-created" });
    });
    children.push(child);
    return child;
  } });
  const generate = (workspace: string, foreground = true, sourcePath = `/sources/${workspace}.jpg`, expectedHash = "a".repeat(64)) =>
    pool.generate(workspace, sourcePath, expectedHash, "/cache", `/workspaces/${workspace}`, foreground);
  const fixture = { pool, children, cleanups, cleanup, generate };
  fixtures.push(fixture);
  return fixture;
}
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.pool.stop();
    fixture.children.forEach((child) => child.exit());
    fixture.cleanups.forEach(({ resolve }) => resolve());
  }
  await settle();
  vi.useRealTimers();
});

it("serializes one workspace while a second healthy workspace completes", async () => {
  const h = harness();
  const firstA = h.generate("A");
  const nextA = h.generate("A");
  const firstB = h.generate("B");
  expect(h.children.map(({ job }) => job.workspaceRoot)).toEqual(["/workspaces/A", "/workspaces/B"]);
  h.children[1].result();
  expect(await firstB).toEqual({ kind: "generated" });
  h.children[1].exit();
  h.cleanups[0].resolve();
  await settle();
  expect(h.children).toHaveLength(2);
  h.children[0].result();
  expect(await firstA).toEqual({ kind: "generated" });
  h.children[0].exit();
  h.cleanups[1].resolve();
  await settle();
  expect(h.children).toHaveLength(3);
  expect(h.children[2].job.workspaceRoot).toBe("/workspaces/A");
  h.children[2].result();
  expect(await nextA).toEqual({ kind: "generated" });
});

it("reserves a foreground slot and gives foreground work priority over queued background work", async () => {
  const h = harness();
  void h.generate("A", false);
  void h.generate("B", false);
  expect(h.children).toHaveLength(1);
  void h.generate("C", true);
  expect(h.children.map(({ job }) => job.workspaceRoot)).toEqual(["/workspaces/A", "/workspaces/C"]);
  h.children[1].result();
  h.children[1].exit();
  h.cleanups[0].resolve();
  await settle();
  expect(h.children).toHaveLength(2);
  h.children[0].result();
  h.children[0].exit();
  h.cleanups[1].resolve();
  await settle();
  expect(h.children[2].job.workspaceRoot).toBe("/workspaces/B");
});

it("quarantines a timed-out workspace and retains its slot and stage through actual exit and cleanup", async () => {
  const h = harness();
  const timedOut = h.generate("A");
  const queuedA = h.generate("A");
  void h.generate("B");
  void h.generate("C");
  await vi.advanceTimersByTimeAsync(IMAGE_IDLE_MS - 1);
  h.children[1].emit("message", { type: "progress" });
  await vi.advanceTimersByTimeAsync(1);
  expect(await timedOut).toMatchObject({ kind: "failed", error: expect.any(Error) });
  expect(await queuedA).toEqual({ kind: "busy" });
  expect(h.children[0].kill).toHaveBeenCalledTimes(1);
  expect(h.children[1].kill).not.toHaveBeenCalled();
  expect(h.cleanup).not.toHaveBeenCalled();
  expect(h.children).toHaveLength(2);
  expect(await h.generate("A")).toEqual({ kind: "busy" });
  void h.generate("D");
  expect(h.children).toHaveLength(2);
  h.children[0].result();
  expect(h.children[0].postMessage).toHaveBeenCalledTimes(1);
  h.children[0].exit();
  expect(h.cleanup).toHaveBeenCalledExactlyOnceWith(h.children[0].job.stageDirectory);
  expect(h.children).toHaveLength(2);
  expect(await h.generate("A")).toEqual({ kind: "busy" });
  h.cleanups[0].resolve();
  await settle();
  // C's queue bound expired while A was retained. D arrived after the timeout
  // and can start only now that exit and cleanup both actually finished.
  expect(h.children).toHaveLength(3);
  expect(h.children[2].job.workspaceRoot).toBe("/workspaces/D");
});

it("resets the active deadline only when progress arrives", async () => {
  const h = harness();
  const result = h.generate("A");
  await vi.advanceTimersByTimeAsync(IMAGE_IDLE_MS - 1);
  h.children[0].emit("message", { type: "stage-created" });
  await vi.advanceTimersByTimeAsync(IMAGE_IDLE_MS - 1);
  expect(h.children[0].kill).not.toHaveBeenCalled();
  h.children[0].emit("message", { type: "progress" });
  await vi.advanceTimersByTimeAsync(IMAGE_IDLE_MS - 1);
  expect(h.children[0].kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.children[0].kill).toHaveBeenCalledTimes(1);
  expect(await result).toMatchObject({ kind: "failed" });
});

it("expires a queued request as busy without disturbing the progressing active child", async () => {
  const h = harness();
  void h.generate("A", false);
  const queued = h.generate("B", false);
  await vi.advanceTimersByTimeAsync(IMAGE_IDLE_MS - 1);
  h.children[0].emit("message", { type: "progress" });
  await vi.advanceTimersByTimeAsync(1);
  expect(await queued).toEqual({ kind: "busy" });
  expect(h.children).toHaveLength(1);
  expect(h.children[0].kill).not.toHaveBeenCalled();
});

it("refuses payloads beyond pending-byte admission without replacing admitted work", async () => {
  const h = harness({ pendingBytes: 4096 });
  void h.generate("A");
  const queued = h.generate("A");
  expect(await h.generate("B", true, `/sources/${"x".repeat(4096)}.jpg`)).toEqual({ kind: "busy" });
  expect(h.children).toHaveLength(1);
  expect(h.children[0].kill).not.toHaveBeenCalled();
  h.children[0].result();
  h.children[0].exit();
  h.cleanups[0].resolve();
  await settle();
  expect(h.children).toHaveLength(2);
  h.children[1].result();
  expect(await queued).toEqual({ kind: "generated" });
});

it("acknowledges a result but starts the next same-workspace job only after exit and cleanup", async () => {
  const h = harness();
  const first = h.generate("A");
  void h.generate("A");
  h.children[0].result();
  expect(await first).toEqual({ kind: "generated" });
  expect(h.children[0].postMessage).toHaveBeenLastCalledWith({ type: "retire" });
  expect(h.cleanup).not.toHaveBeenCalled();
  expect(h.children).toHaveLength(1);
  h.children[0].exit();
  expect(h.cleanup).toHaveBeenCalledWith(h.children[0].job.stageDirectory);
  expect(h.children).toHaveLength(1);
  h.cleanups[0].resolve();
  await settle();
  expect(h.children).toHaveLength(2);
});

it("stops queued and active work immediately without waiting for child exits", async () => {
  const h = harness();
  const active = [h.generate("A"), h.generate("B")];
  const queued = [h.generate("A"), h.generate("C")];
  expect(h.pool.stop()).toBeUndefined();
  expect(await Promise.all(active)).toEqual([
    expect.objectContaining({ kind: "failed" }), expect.objectContaining({ kind: "failed" }),
  ]);
  expect(await Promise.all(queued)).toEqual([{ kind: "busy" }, { kind: "busy" }]);
  expect(h.children.every((child) => !child.exited && child.kill.mock.calls.length === 1)).toBe(true);
  expect(h.cleanup).not.toHaveBeenCalled();
  expect(await h.generate("D")).toEqual({ kind: "busy" });
});

it("leaves an unclaimed stage untouched after its child exits", async () => {
  const h = harness({ stageOwned: false });
  const result = h.generate("A");
  h.children[0].result();
  expect(await result).toEqual({ kind: "generated" });
  h.children[0].exit();
  await settle();
  expect(h.cleanup).not.toHaveBeenCalled();
  void h.generate("A");
  expect(h.children).toHaveLength(2);
});

it("promotes a now-visible queued image into the reserved foreground slot", () => {
  const h = harness();
  void h.generate("A", false);
  void h.generate("B", false, "/sources/B.jpg", "b".repeat(64));
  void h.generate("C", false, "/sources/C.jpg", "c".repeat(64));
  expect(h.children).toHaveLength(1);
  h.pool.promote("c".repeat(64));
  expect(h.children.map(({ job }) => job.workspaceRoot)).toEqual(["/workspaces/A", "/workspaces/C"]);
});
