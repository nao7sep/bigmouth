import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackupWorkerRequest } from "@main/core/services/backupWorker.js";

interface FakeRecorder {
  messages: BackupWorkerRequest[];
  emit(event: string, ...args: unknown[]): boolean;
  terminate: ReturnType<typeof vi.fn<() => Promise<number>>>;
  finish(): void;
}

const fake = vi.hoisted(() => ({
  workers: [] as FakeRecorder[],
  databasePath: "",
  warn: vi.fn(),
}));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  class Worker extends EventEmitter implements FakeRecorder {
    readonly messages: BackupWorkerRequest[] = [];
    readonly terminate: ReturnType<typeof vi.fn<() => Promise<number>>>;
    readonly finish: () => void;
    constructor() {
      super();
      let complete!: (code: number) => void;
      const terminated = new Promise<number>((resolve) => { complete = resolve; });
      this.finish = () => complete(0);
      this.terminate = vi.fn(() => terminated);
      fake.workers.push(this);
    }
    unref(): this { return this; }
    postMessage(request: BackupWorkerRequest): void { this.messages.push(request); }
  }
  return { Worker };
});

vi.mock("@main/core/services/storagePaths.js", () => ({
  getBackupsDbPath: () => fake.databasePath,
}));

vi.mock("@main/core/services/logger.js", () => ({
  warn: fake.warn,
  serializeError: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
}));

let root: string;
const descriptors = new Set<number>();

beforeEach(() => {
  vi.resetModules();
  fake.workers = [];
  fake.warn.mockClear();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-backup-delivery-"));
  fake.databasePath = path.join(root, "backups.sqlite3");
});

afterEach(async () => {
  for (const worker of fake.workers) worker.finish();
  await Promise.resolve();
  for (const fd of descriptors) {
    try { fs.closeSync(fd); } catch { /* Production already released this descriptor. */ }
  }
  descriptors.clear();
  fs.rmSync(root, { recursive: true, force: true });
});

function pin(name: string) {
  const file = path.join(root, name);
  fs.writeFileSync(file, name);
  const fd = fs.openSync(file, "r");
  descriptors.add(fd);
  return { file, fd, size: Buffer.byteLength(name) };
}

const expectOpen = (fd: number) => expect(fs.fstatSync(fd).isFile()).toBe(true);
const expectClosed = (fd: number) => expect(() => fs.fstatSync(fd)).toThrow(/EBADF/);

function acknowledge(worker: FakeRecorder, index: number): void {
  Atomics.store(worker.messages[index].signal, 0, 1);
  worker.emit("message", { kind: "settled" });
}

describe("backup store delivery ownership", () => {
  it.each(["error", "messageerror"])("retains an active descriptor after worker %s until physical termination and disables later recording", async (event) => {
    const { recordFile } = await import("@main/core/services/backupStore.js");
    const active = pin("active");
    const queued = pin("queued");
    recordFile(active.file, active.fd, "a".repeat(64), active.size);
    recordFile(queued.file, queued.fd, "b".repeat(64), queued.size);
    expect(fake.workers).toHaveLength(1);
    const worker = fake.workers[0];
    expect(worker.messages).toHaveLength(1);

    worker.emit(event, new Error("recorder failed"));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expectOpen(active.fd);
    expectClosed(queued.fd);
    expect(fake.warn).toHaveBeenCalledTimes(1);

    const duringRetirement = pin("during-retirement");
    recordFile(duringRetirement.file, duringRetirement.fd, "c".repeat(64), duringRetirement.size);
    expectClosed(duringRetirement.fd);
    expectOpen(active.fd);
    expect(fake.workers).toHaveLength(1);

    worker.finish();
    await Promise.resolve();
    expectClosed(active.fd);
    const later = pin("later");
    recordFile(later.file, later.fd, "d".repeat(64), later.size);
    expectClosed(later.fd);
    expect(fake.workers).toHaveLength(1);
  });

  it("returns a shared retirement lifetime from zero-bound stops and blocks a new recorder until it settles", async () => {
    const { recordFile, stopBackups } = await import("@main/core/services/backupStore.js");
    const active = pin("active");
    const queued = pin("queued");
    recordFile(active.file, active.fd, "a".repeat(64), active.size);
    recordFile(queued.file, queued.fd, "b".repeat(64), queued.size);
    const worker = fake.workers[0];
    const stopped = stopBackups(0);
    expect(stopBackups(0)).toBe(stopped);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expectOpen(active.fd);
    expectClosed(queued.fd);
    let retired = false;
    void stopped.then(() => { retired = true; });
    await Promise.resolve();
    expect(retired).toBe(false);

    const duringRetirement = pin("during-retirement");
    recordFile(duringRetirement.file, duringRetirement.fd, "c".repeat(64), duringRetirement.size);
    expectClosed(duringRetirement.fd);
    expect(fake.workers).toHaveLength(1);
    expectOpen(active.fd);

    worker.finish();
    await stopped;
    expectClosed(active.fd);
    expect(retired).toBe(true);
    const later = pin("later");
    recordFile(later.file, later.fd, "d".repeat(64), later.size);
    expect(fake.workers).toHaveLength(2);
    expectOpen(later.fd);
    const nextStop = stopBackups(0);
    fake.workers[1].finish();
    await nextStop;
    expectClosed(later.fd);
  });

  it("returns from held byte recording without waiting and sends only the newest pending save after acknowledgement", async () => {
    const { record, stopBackups } = await import("@main/core/services/backupStore.js");
    const wait = vi.spyOn(Atomics, "wait");
    try {
      record(path.join(root, "active.md"), new Uint8Array([1]));
      record(path.join(root, "pending.md"), new Uint8Array([2]));
      const newest = new Uint8Array([3, 4]);
      record(path.join(root, "pending.md"), newest);
      newest.fill(0);
      expect(fake.workers).toHaveLength(1);
      const worker = fake.workers[0];
      expect(worker.messages).toHaveLength(1);
      expect(wait).not.toHaveBeenCalled();
      acknowledge(worker, 0);
      expect(worker.messages).toHaveLength(2);
      expect(worker.messages[1]).toMatchObject({ kind: "record", path: path.join(root, "pending.md"), bytes: new Uint8Array([3, 4]) });
      expect(wait).not.toHaveBeenCalled();
      acknowledge(worker, 1);
      const stopped = stopBackups(0);
      worker.finish();
      await stopped;
    } finally { wait.mockRestore(); }
  });
});
