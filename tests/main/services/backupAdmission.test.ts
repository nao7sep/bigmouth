import { describe, expect, it, vi } from "vitest";
import { BackupAdmission } from "@main/core/services/backupAdmission.js";
import type { BackupWrite } from "@main/core/services/backupWorker.js";

const metadata = {
  file: "backups.sqlite3",
  sessionId: "session",
  writtenAt: "2026-10-23T00:00:00.000Z",
  partSize: 1024,
};

function record(path: string, bytes = new Uint8Array([1])): BackupWrite {
  return { ...metadata, kind: "record", path, bytes };
}

function file(path: string, fd: number): BackupWrite {
  return { ...metadata, kind: "record-file", path, fd, sha256: "a".repeat(64), size: 1 };
}

function admission(limits = { bytes: 16 * 1024, descriptors: 4 }) {
  const issued: Array<{ write: BackupWrite; signal: Int32Array }> = [];
  const release = vi.fn<(write: BackupWrite) => void>();
  const overflow = vi.fn();
  const queue = new BackupAdmission(limits, (write, signal) => issued.push({ write, signal }), release, overflow);
  const complete = (index: number) => {
    Atomics.store(issued[index].signal, 0, 1);
    Atomics.notify(issued[index].signal, 0);
  };
  return { queue, issued, release, overflow, complete };
}

describe("BackupAdmission", () => {
  it("holds one active write and orders replaced pending paths by their latest saves", () => {
    const { queue, issued, release, complete } = admission();
    const firstB = record("B", new Uint8Array([2]));
    const latestB = record("B", new Uint8Array([4]));
    queue.offer(record("A"));
    queue.offer(firstB);
    queue.offer(record("C", new Uint8Array([3])));
    queue.offer(latestB);
    expect(issued.map(({ write }) => write.path)).toEqual(["A"]);
    expect(release.mock.calls.map(([write]) => write)).toEqual([firstB]);

    complete(0);
    queue.reap();
    expect(issued.map(({ write }) => write.path)).toEqual(["A", "C"]);
    complete(1);
    queue.reap();
    expect(issued.map(({ write }) => write.path)).toEqual(["A", "C", "B"]);
    expect(issued[2].write).toEqual(latestB);
    complete(2);
    expect(queue.drain(0)).toBe(true);
    expect(release).toHaveBeenCalledTimes(4);
  });

  it("snapshots exactly the caller's active and pending byte views", () => {
    const { queue, issued, complete } = admission();
    const backing = new Uint8Array([99, 1, 2, 3, 99]);
    const active = record("active", backing.subarray(1, 4));
    const pendingBytes = new Uint8Array([4, 5]);
    queue.offer(active);
    queue.offer(record("pending", pendingBytes));
    backing.fill(0);
    pendingBytes.fill(0);
    expect(issued[0].write).toEqual({ ...active, bytes: new Uint8Array([1, 2, 3]) });
    complete(0);
    queue.reap();
    expect(issued[1].write).toEqual(record("pending", new Uint8Array([4, 5])));
    complete(1);
    expect(queue.drain(0)).toBe(true);
  });

  it("coalesces byte-budget overflow diagnostics until admitted work has drained", () => {
    const { queue, issued, overflow, release, complete } = admission({ bytes: 2500, descriptors: 4 });
    const request = () => record("large", new Uint8Array(1024));
    queue.offer(request());
    const rejected = [request(), request()];
    for (const write of rejected) queue.offer(write);
    expect(issued).toHaveLength(1);
    expect(overflow).toHaveBeenCalledTimes(1);
    expect(release.mock.calls.map(([write]) => write)).toEqual(rejected);
    complete(0);
    expect(queue.drain(0)).toBe(true);
    queue.offer(request());
    queue.offer(request());
    expect(issued).toHaveLength(2);
    expect(overflow).toHaveBeenCalledTimes(2);
    queue.retired();
  });

  it("does not repeat an overflow notice when no oversized write can be admitted", () => {
    const { queue, issued, overflow, complete } = admission({ bytes: 2000, descriptors: 1 });
    queue.offer(record("oversized", new Uint8Array(2000)));
    queue.offer(record("oversized", new Uint8Array(2000)));
    expect(issued).toHaveLength(0);
    expect(overflow).toHaveBeenCalledTimes(1);
    queue.offer(record("small"));
    complete(0);
    queue.reap();
    queue.offer(record("oversized", new Uint8Array(2000)));
    expect(overflow).toHaveBeenCalledTimes(2);
  });

  it("bounds file descriptors and releases each rejected descriptor once with one overflow notice", () => {
    const { queue, issued, release, overflow, complete } = admission({ bytes: 16 * 1024, descriptors: 1 });
    queue.offer(file("active", 10));
    queue.offer(file("rejected-one", 11));
    queue.offer(file("rejected-two", 12));
    expect(issued).toHaveLength(1);
    expect(release.mock.calls.map(([write]) => write.kind === "record-file" && write.fd)).toEqual([11, 12]);
    expect(overflow).toHaveBeenCalledTimes(1);
    complete(0);
    expect(queue.drain(0)).toBe(true);
    queue.offer(file("later-active", 13));
    queue.offer(file("later-rejected", 14));
    expect(overflow).toHaveBeenCalledTimes(2);
    queue.retired();
    expect(release.mock.calls.map(([write]) => write.kind === "record-file" && write.fd)).toEqual([11, 12, 10, 14, 13]);
  });

  it("releases superseded and abandoned descriptors once while retaining the active one until retirement", () => {
    const { queue, release } = admission({ bytes: 16 * 1024, descriptors: 3 });
    queue.offer(file("active", 10));
    queue.offer(file("pending", 11));
    queue.offer(file("pending", 12));
    queue.offer(file("other-pending", 13));
    expect(release.mock.calls.map(([write]) => write.kind === "record-file" && write.fd)).toEqual([11]);
    queue.abandonPending();
    queue.abandonPending();
    expect(release.mock.calls.map(([write]) => write.kind === "record-file" && write.fd)).toEqual([11, 12, 13]);
    expect(queue.drain(0)).toBe(false);
    queue.retired();
    queue.retired();
    expect(release.mock.calls.map(([write]) => write.kind === "record-file" && write.fd)).toEqual([11, 12, 13, 10]);
    expect(queue.drain(0)).toBe(true);
  });

  it("drains through shared completion signals without requiring a callback on the origin", () => {
    const issued: BackupWrite[] = [];
    let heldSignal: Int32Array | undefined;
    const release = vi.fn<(write: BackupWrite) => void>();
    const queue = new BackupAdmission({ bytes: 8 * 1024, descriptors: 1 }, (write, signal) => {
      issued.push(write);
      if (write.path === "A") { heldSignal = signal; return; }
      // This is the worker's shared-memory acknowledgement; no origin callback
      // calls reap or changes the queue while the origin drains.
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
    }, release, vi.fn());
    queue.offer(record("A"));
    queue.offer(record("B"));
    expect(issued.map((write) => write.path)).toEqual(["A"]);
    Atomics.store(heldSignal!, 0, 1);
    expect(queue.drain(1000)).toBe(true);
    expect(issued.map((write) => write.path)).toEqual(["A", "B"]);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("releases an incoming descriptor if advancing earlier work throws before admission", () => {
    const release = vi.fn<(write: BackupWrite) => void>();
    let signal!: Int32Array;
    const queue = new BackupAdmission({ bytes: 10000, descriptors: 3 }, (write, completion) => {
      if (write.path === "second") throw new Error("transport lost");
      signal = completion;
    }, release, vi.fn());
    queue.offer(file("first", 1));
    queue.offer(file("second", 2));
    Atomics.store(signal, 0, 1);
    expect(() => queue.offer(file("incoming", 3))).toThrow("transport lost");
    expect(release.mock.calls.map(([write]) => write.kind === "record-file" && write.fd)).toEqual([1, 3]);
    queue.retired();
    expect(release.mock.calls.map(([write]) => write.kind === "record-file" && write.fd)).toEqual([1, 3, 2]);
  });

  it("runs each entry's zero-argument release callback in discard order", () => {
    const { queue, release, complete } = admission();
    const released: string[] = [];
    const activeReleased = vi.fn(() => { released.push("active"); });
    const supersededReleased = vi.fn(() => { released.push("superseded"); });
    const latestReleased = vi.fn(() => { released.push("latest"); });
    queue.offer(record("active"), activeReleased);
    queue.offer(record("pending"), supersededReleased);
    queue.offer(record("pending", new Uint8Array([2])), latestReleased);
    expect(released).toEqual(["superseded"]);
    complete(0);
    queue.reap();
    expect(released).toEqual(["superseded", "active"]);
    queue.retired();
    expect(released).toEqual(["superseded", "active", "latest"]);
    for (const callback of [activeReleased, supersededReleased, latestReleased]) {
      expect(callback).toHaveBeenCalledExactlyOnceWith();
    }
    expect(release).not.toHaveBeenCalled();
    expect(queue.isIdle).toBe(true);
  });

  it("uses the entry's zero-argument callback when its ownership budget rejects it", () => {
    const { queue, release } = admission({ bytes: 1, descriptors: 0 });
    const custom = vi.fn();
    queue.offer(file("rejected", 10), custom);
    expect(custom).toHaveBeenCalledExactlyOnceWith();
    expect(release).not.toHaveBeenCalled();
    expect(queue.isIdle).toBe(true);
  });

  it("passes the owned byte snapshot to the default release after admitted completion", () => {
    const { queue, issued, release, complete } = admission();
    const submitted = record("active");
    queue.offer(submitted);
    complete(0);
    queue.reap();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][0]).toBe(issued[0].write);
    expect(release.mock.calls[0][0]).not.toBe(submitted);
  });

  it("returns false for a held request with a zero drain bound", () => {
    const { queue, issued, release } = admission();
    queue.offer(record("held"));
    expect(queue.drain(0)).toBe(false);
    expect(issued).toHaveLength(1);
    expect(release).not.toHaveBeenCalled();
    queue.retired();
  });
});
