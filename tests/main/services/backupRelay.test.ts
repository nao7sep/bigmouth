import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { BackupRelay, type BackupRelayRequest } from "@main/core/services/backupRelay.js";
import type { BackupWrite, BackupWorkerRequest } from "@main/core/services/backupWorker.js";

interface FakeRecorder {
  messages: BackupWorkerRequest[];
  emit(event: string, ...args: unknown[]): boolean;
  finish(): void;
}
const fake = vi.hoisted(() => ({ workers: [] as FakeRecorder[], destination: "", warn: vi.fn() }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:worker_threads")>();
  const { EventEmitter } = await import("node:events");
  class Worker extends EventEmitter {
    readonly messages: BackupWorkerRequest[] = [];
    readonly termination: Promise<number>;
    readonly finish: () => void;
    constructor() {
      super();
      let resolve!: (code: number) => void;
      this.termination = new Promise((done) => { resolve = done; });
      this.finish = () => resolve(0);
      fake.workers.push(this);
    }
    unref(): this { return this; }
    postMessage(request: BackupWorkerRequest): void { this.messages.push(request); }
    terminate(): Promise<number> { return this.termination; }
  }
  return { ...original, Worker };
});
vi.mock("@main/core/services/storagePaths.js", () => ({ getBackupsDbPath: () => fake.destination }));
vi.mock("@main/core/services/logger.js", () => ({ warn: fake.warn, serializeError: (error: unknown) => String(error) }));

let root: string;
let broker: typeof import("@main/core/services/backupStore.js");
const ports: MessagePort[] = [];
const openDescriptors = new Set<number>();
const limits = { bytes: 32 * 1024, descriptors: 4 };
const metadata = { file: "/origin/forged.sqlite3", sessionId: "origin-session", writtenAt: "2026-10-23T00:00:00.000Z", partSize: 4 };

beforeEach(async () => {
  vi.resetModules();
  fake.workers = [];
  fake.warn.mockClear();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-backup-relay-"));
  fake.destination = path.join(root, "backups.sqlite3");
  broker = await import("@main/core/services/backupStore.js");
});
afterEach(async () => {
  const stopped = broker.stopBackups(0);
  for (const worker of fake.workers) worker.finish();
  await stopped;
  for (const port of ports) port.close();
  ports.length = 0;
  for (const fd of openDescriptors) {
    try { fs.closeSync(fd); } catch { /* The originating relay already released it. */ }
  }
  openDescriptors.clear();
  fs.rmSync(root, { recursive: true, force: true });
});

function origin() {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  broker.attachBackupRelay(port2);
  return { relay: new BackupRelay(port1, limits, fake.warn), receiver: port2, sender: port1 };
}
function bytes(name: string, value = 1): BackupWrite {
  return { ...metadata, kind: "record", path: path.join(root, name), bytes: new Uint8Array([value]) };
}
function pinned(name: string): Extract<BackupWrite, { kind: "record-file" }> {
  const file = path.join(root, name);
  fs.writeFileSync(file, name);
  const fd = fs.openSync(file, "r");
  openDescriptors.add(fd);
  return { ...metadata, kind: "record-file", path: file, fd, sha256: "a".repeat(64), size: Buffer.byteLength(name) };
}
function ack(index: number): void {
  const worker = fake.workers[0];
  Atomics.store(worker.messages[index].signal, 0, 1);
  Atomics.notify(worker.messages[index].signal, 0);
  worker.emit("message", { kind: "settled" });
}
const expectClosed = (fd: number) => expect(() => fs.fstatSync(fd)).toThrow(/EBADF/);

it("shares one central recorder across main and origins and overrides the destination and session", async () => {
  broker.record(path.join(root, "main.md"), new Uint8Array([9]));
  const a = origin();
  const b = origin();
  const arrivals = [once(a.receiver, "message"), once(b.receiver, "message")];
  a.relay.offer(bytes("a.md", 2));
  b.relay.offer(bytes("b.md", 3));
  await Promise.all(arrivals);
  expect(fake.workers).toHaveLength(1);
  const worker = fake.workers[0];
  expect(worker.messages).toHaveLength(1);
  ack(0);
  ack(1);
  ack(2);
  await Promise.all([a.relay.idle(), b.relay.idle()]);
  const submitted = worker.messages as Array<BackupWrite & { signal: Int32Array }>;
  expect(submitted.map(({ file }) => file)).toEqual([fake.destination, fake.destination, fake.destination]);
  expect(submitted.map(({ sessionId }) => sessionId)).toEqual(Array(3).fill(submitted[0].sessionId));
  expect(submitted[1].sessionId).not.toBe(metadata.sessionId);
  expect(submitted.slice(1).map(({ writtenAt }) => writtenAt)).toEqual([metadata.writtenAt, metadata.writtenAt]);
  expect(submitted.slice(1).map((write) => write.kind === "record" ? write.bytes[0] : null).sort()).toEqual([2, 3]);
});

it("keeps the active real descriptor until broker retirement while replacements and unsent pending versions release locally", async () => {
  const { relay, receiver } = origin();
  const active = pinned("active");
  const superseded = pinned("pending");
  const latest = pinned("latest");
  latest.path = superseded.path;
  const arrived = once(receiver, "message");
  relay.offer(active);
  relay.offer(superseded);
  relay.offer(latest);
  expectClosed(superseded.fd);
  await arrived;
  expect(fs.fstatSync(active.fd).isFile()).toBe(true);
  const stopped = relay.stop();
  expectClosed(latest.fd);
  expect(relay.isIdle).toBe(false);
  let retired = false;
  void stopped.then(() => { retired = true; });
  const brokerStopped = broker.stopBackups(0);
  await Promise.resolve();
  expect(retired).toBe(false);
  expect(fs.fstatSync(active.fd).isFile()).toBe(true);
  fake.workers[0].finish();
  await brokerStopped;
  await stopped;
  expectClosed(active.fd);
  expect(relay.isIdle).toBe(true);
});

it("acknowledges broker rejection and queued retirement without closing an active borrowed descriptor early", async () => {
  const a = origin();
  const b = origin();
  const active = pinned("active");
  const queued = pinned("queued");
  const arrivedA = once(a.receiver, "message");
  a.relay.offer(active);
  await arrivedA;
  const arrivedB = once(b.receiver, "message");
  b.relay.offer(queued);
  await arrivedB;
  fake.workers[0].emit("error", new Error("recorder failure"));
  await b.relay.idle();
  expectClosed(queued.fd);
  expect(fs.fstatSync(active.fd).isFile()).toBe(true);
  const rejected = pinned("rejected");
  const arrivedRejected = once(b.receiver, "message");
  b.relay.offer(rejected);
  await arrivedRejected;
  await b.relay.idle();
  expectClosed(rejected.fd);
  expect(fake.workers).toHaveLength(1);
  fake.workers[0].finish();
  await a.relay.idle();
  expectClosed(active.fd);
});

it("does not invent release when the receiving channel disappears", async () => {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  const relay = new BackupRelay(port1, limits, fake.warn);
  const received = once(port2, "message");
  const active = pinned("active");
  relay.offer(active);
  const [request] = await received as [BackupRelayRequest];
  const closed = once(port1, "close");
  port2.close();
  await closed;
  expect(relay.isIdle).toBe(false);
  expect(fs.fstatSync(active.fd).isFile()).toBe(true);
  const stopped = relay.stop();
  Atomics.store(request.release, 0, 1);
  Atomics.notify(request.release, 0);
  await stopped;
  expectClosed(active.fd);
});

it("configures an origin without local storage initialization and exposes physical relay idleness", async () => {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  vi.resetModules();
  const originStore = await import("@main/core/services/backupStore.js");
  originStore.configureBackupRelay(port1, limits);
  const received = once(port2, "message");
  const active = pinned("active");
  originStore.recordFile(active.path, active.fd, active.sha256, active.size);
  expect(originStore.isBackupRelayIdle()).toBe(false);
  const [request] = await received as [BackupRelayRequest];
  expect(request.write.file).toBe("");
  expect(fake.workers).toHaveLength(0);
  const stopped = originStore.stopBackups(0);
  expect(fs.fstatSync(active.fd).isFile()).toBe(true);
  Atomics.store(request.release, 0, 1);
  Atomics.notify(request.release, 0);
  await stopped;
  await originStore.backupRelayIdle();
  expect(originStore.isBackupRelayIdle()).toBe(true);
  expectClosed(active.fd);
});


it("releases a descriptor after a synchronous postMessage rejection that submitted nothing", async () => {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  const relay = new BackupRelay(port1, limits, fake.warn);
  const active = pinned("not-submitted");
  const post = vi.spyOn(port1, "postMessage").mockImplementation(() => { throw new Error("injected clone failure"); });
  try {
    relay.offer(active);
    await relay.idle();
    expectClosed(active.fd);
    expect(relay.isIdle).toBe(true);
    expect(fake.warn).toHaveBeenCalledWith("backup relay could not submit a saved version", expect.any(Error));
  } finally { post.mockRestore(); }
});

it("handles a release racing waitAsync registration through its synchronous result", async () => {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  const relay = new BackupRelay(port1, limits, fake.warn);
  const active = pinned("racing-release");
  const post = vi.spyOn(port1, "postMessage").mockImplementation((request: BackupRelayRequest) => {
    Atomics.store(request.release, 0, 1);
  });
  // The observer saw zero just before the broker set one. waitAsync itself
  // therefore sees the completed release and returns 'not-equal' synchronously.
  const load = vi.spyOn(Atomics as { load(array: Int32Array, index: number): number }, "load").mockReturnValueOnce(0);
  try {
    relay.offer(active);
    await relay.idle();
    expectClosed(active.fd);
    expect(relay.isIdle).toBe(true);
  } finally {
    load.mockRestore();
    post.mockRestore();
  }
});


it("short-drains admitted pending versions before stopping ordinary-quit admission", async () => {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  const relay = new BackupRelay(port1, limits, fake.warn);
  const active = pinned("active-drain");
  const pending = pinned("pending-drain");
  const submitted: BackupRelayRequest[] = [];
  const post = vi.spyOn(port1, "postMessage").mockImplementation((request: BackupRelayRequest) => { submitted.push(request); });
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const wait = vi.spyOn(Atomics as {
    wait(array: Int32Array, index: number, value: number, timeout?: number): "ok" | "not-equal" | "timed-out";
  }, "wait").mockImplementation((signal) => {
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
    return "ok";
  });
  try {
    relay.offer(active);
    relay.offer(pending);
    expect(submitted).toHaveLength(1);
    await relay.stop(1000);
    expect(submitted.map(({ write }) => write.path)).toEqual([active.path, pending.path]);
    expect(wait).toHaveBeenCalledTimes(2);
    expectClosed(active.fd);
    expectClosed(pending.fd);
    expect(relay.isIdle).toBe(true);
  } finally {
    wait.mockRestore();
    clock.mockRestore();
    post.mockRestore();
  }
});

it("abandons unsent work after short-drain expiry but retains the active descriptor until release", async () => {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  const relay = new BackupRelay(port1, limits, fake.warn);
  const active = pinned("active-expiry");
  const pending = pinned("pending-expiry");
  let submitted!: BackupRelayRequest;
  const post = vi.spyOn(port1, "postMessage").mockImplementation((request: BackupRelayRequest) => { submitted = request; });
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
  try {
    relay.offer(active);
    relay.offer(pending);
    const stopped = relay.stop(1000);
    expectClosed(pending.fd);
    expect(fs.fstatSync(active.fd).isFile()).toBe(true);
    expect(relay.isIdle).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
    Atomics.store(submitted.release, 0, 1);
    Atomics.notify(submitted.release, 0);
    await stopped;
    expectClosed(active.fd);
  } finally {
    wait.mockRestore();
    clock.mockRestore();
    post.mockRestore();
  }
});

it("drops late relay and local writes after production admission is sealed without restarting the recorder", async () => {
  const { relay, receiver } = origin();
  const active = pinned("active-before-shutdown");
  const arrived = once(receiver, "message");
  relay.offer(active);
  await arrived;
  broker.beginBackupShutdown();
  const stopped = broker.stopBackups(0);
  fake.workers[0].finish();
  await stopped;
  await relay.idle();
  expectClosed(active.fd);

  const late = pinned("late-relay");
  const arrivedLate = once(receiver, "message");
  relay.offer(late);
  await arrivedLate;
  await relay.idle();
  expectClosed(late.fd);
  const local = pinned("late-local");
  broker.recordFile(local.path, local.fd, local.sha256, local.size);
  expectClosed(local.fd);
  expect(fake.workers).toHaveLength(1);
});
