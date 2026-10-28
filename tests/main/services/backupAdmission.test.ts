import { describe, expect, it, vi } from "vitest";
import { BackupAdmission } from "@main/core/services/backupAdmission.js";
import type { BackupWrite } from "@main/core/services/backupWorker.js";

const metadata = {
  file: "backups.sqlite3",
  sessionId: "session",
  writtenAt: "2026-10-23T00:00:00.000Z",
};

function record(path: string, bytes = new Uint8Array([1])): BackupWrite {
  return { ...metadata, kind: "record", path, bytes };
}

function file(path: string, fd: number): BackupWrite {
  return { ...metadata, kind: "record-file", path, fd, sha256: "a".repeat(64), size: 1 };
}

function admission() {
  const issued: BackupWrite[] = [];
  const release = vi.fn<(write: BackupWrite) => void>();
  const queue = new BackupAdmission((write) => issued.push(write), release);
  return { queue, issued, release };
}

const fds = (release: ReturnType<typeof admission>["release"]) =>
  release.mock.calls.map(([write]) => write.kind === "record-file" && write.fd);

describe("BackupAdmission", () => {
  it("holds one write in flight and orders replaced pending paths by their latest saves", () => {
    const { queue, issued, release } = admission();
    const firstB = record("B", new Uint8Array([2]));
    const latestB = record("B", new Uint8Array([4]));
    queue.offer(record("A"));
    queue.offer(firstB);
    queue.offer(record("C", new Uint8Array([3])));
    queue.offer(latestB);
    expect(issued.map((write) => write.path)).toEqual(["A"]);
    expect(release.mock.calls.map(([write]) => write)).toEqual([firstB]);

    queue.settled();
    expect(issued.map((write) => write.path)).toEqual(["A", "C"]);
    queue.settled();
    expect(issued.map((write) => write.path)).toEqual(["A", "C", "B"]);
    expect(issued[2]).toEqual(latestB);
  });

  it("snapshots exactly the caller's byte views", () => {
    const { queue, issued } = admission();
    const backing = new Uint8Array([99, 1, 2, 3, 99]);
    const active = record("active", backing.subarray(1, 4));
    const pendingBytes = new Uint8Array([4, 5]);
    queue.offer(active);
    queue.offer(record("pending", pendingBytes));
    backing.fill(0);
    pendingBytes.fill(0);
    expect(issued[0]).toEqual({ ...active, bytes: new Uint8Array([1, 2, 3]) });
    queue.settled();
    expect(issued[1]).toEqual(record("pending", new Uint8Array([4, 5])));
  });

  it("releases superseded and abandoned descriptors once, and a sent one only after the recorder settles it", () => {
    const { queue, release } = admission();
    queue.offer(file("active", 10));
    queue.offer(file("pending", 11));
    queue.offer(file("pending", 12));
    queue.offer(file("other-pending", 13));
    expect(fds(release)).toEqual([11]);
    queue.abandonPending();
    queue.abandonPending();
    expect(fds(release)).toEqual([11, 12, 13]);
    queue.settled();
    expect(fds(release)).toEqual([11, 12, 13, 10]);
  });

  it("hands every pending write over in save order for a final drain", () => {
    const { queue, issued } = admission();
    queue.offer(record("A"));
    queue.offer(record("B"));
    queue.offer(record("C"));
    queue.flush();
    expect(issued.map((write) => write.path)).toEqual(["A", "B", "C"]);
    queue.offer(record("D"));
    expect(issued.map((write) => write.path)).toEqual(["A", "B", "C"]);
    queue.settled();
    queue.settled();
    queue.settled();
    expect(issued.map((write) => write.path)).toEqual(["A", "B", "C", "D"]);
  });
});
