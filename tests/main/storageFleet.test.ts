import { EventEmitter } from "node:events";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStorageFleet } from "@main/storageFleet.js";
import { StorageOwner, STORAGE_WAIT_MS, type StorageRequest, type StorageFlushRequest, type StorageFinishRequest } from "@main/storageOwner.js";
import type { Workspace } from "@shared/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

type Control = StorageFlushRequest | StorageFinishRequest;
class FakeWorker extends EventEmitter {
  readonly requests: StorageRequest[] = [];
  readonly controls: Control[] = [];
  readonly terminationStarted = deferred<void>();
  retirement: ReturnType<typeof deferred<number>> | null = null;
  terminateCalls = 0;
  canRetire = false;
  constructor(readonly workspace: boolean, private readonly receive: (worker: FakeWorker, request: StorageRequest) => void) { super(); }
  unref(): void {}
  postMessage(message: StorageRequest | Control): void {
    if ("name" in message) {
      this.requests.push(message);
      this.receive(this, message);
    } else this.controls.push(message);
  }
  reply(request: StorageRequest, value: unknown): void { this.emit("message", { id: request.id, ok: true, value }); }
  async terminate(): Promise<number> {
    this.terminateCalls += 1;
    this.terminationStarted.resolve();
    return this.retirement ? this.retirement.promise : 0;
  }
}

const ROOT_A = path.resolve("/fleet/a");
const ROOT_B = path.resolve("/fleet/b");
const ROOT_C = path.resolve("/fleet/c");
const EDITED_AT = new Date("2026-10-23T00:00:00.000Z");
const opened: Array<ReturnType<typeof harness>> = [];

function harness(aliases: ReadonlyMap<string, string> = new Map()) {
  const workspaces = new Map<string, Workspace>([
    ["a", { id: "a", name: "A", dataDirectory: ROOT_A }],
    ["b", { id: "b", name: "B", dataDirectory: ROOT_B }],
  ]);
  const workers: FakeWorker[] = [];
  const blockedRoots = new Set<string>();
  const blockedProbes = new Set<string>();
  const heldCommands = new Set<StorageRequest["name"]>();
  const seen: Array<{ worker: FakeWorker; request: StorageRequest }> = [];
  const waiters: Array<{ predicate: (request: StorageRequest) => boolean; resolve: (value: { worker: FakeWorker; request: StorageRequest }) => void }> = [];
  const receive = (worker: FakeWorker, request: StorageRequest) => {
    const item = { worker, request };
    seen.push(item);
    for (const waiter of [...waiters]) if (waiter.predicate(request)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(item);
    }
    if (heldCommands.has(request.name) || (request.name === "selectWorkspaceDirectory" && blockedProbes.has(String(request.args[0])))) return;
    if (request.name === "selectWorkspaceDirectory") worker.reply(request, aliases.get(String(request.args[0])) ?? request.args[0]);
    else if (request.name === "canRetireWorkspace") worker.reply(request, worker.canRetire);
    else if (request.name === "getPost" && blockedRoots.has(String(request.args[0]))) return;
    else if (request.name === "getWorkspace") worker.reply(request, workspaces.get(String(request.args[0])) ?? null);
    else if (request.name === "listWorkspaces") worker.reply(request, [...workspaces.values()]);
    else if (request.name === "registerPreparedWorkspace") {
      const workspace = request.args[0] as Workspace;
      workspaces.set(workspace.id, workspace);
      worker.reply(request, workspace);
    }
    else if (request.name === "updateWorkspace") {
      const workspace = { ...workspaces.get(String(request.args[0]))!, ...(request.args[1] as Partial<Workspace>) };
      workspaces.set(workspace.id, workspace);
      worker.reply(request, workspace);
    } else worker.reply(request, null);
  };
  const stopBackups = vi.fn(async () => {});
  const fleet = createStorageFleet(StorageOwner, {
    capacity: 2,
    createOwner: (workspace) => {
      const worker = new FakeWorker(workspace, receive);
      workers.push(worker);
      return new StorageOwner(() => worker as unknown as Worker);
    },
    stopBackups,
  });
  const request = (predicate: (request: StorageRequest) => boolean) => {
    const item = seen.find((item) => predicate(item.request));
    return item ? Promise.resolve(item) : new Promise<{ worker: FakeWorker; request: StorageRequest }>((resolve) => { waiters.push({ predicate, resolve }); });
  };
  const workerAt = (root: string) => workers.find((worker) => worker.requests.some((request) => request.name === "selectWorkspaceDirectory" && request.args[0] === root))!;
  return { fleet, workers, blockedRoots, blockedProbes, heldCommands, workspaces, seen, request, workerAt, stopBackups };
}

function setup(aliases?: ReadonlyMap<string, string>) {
  const value = harness(aliases);
  opened.push(value);
  return value;
}

afterEach(async () => {
  for (const value of opened.splice(0)) {
    for (const worker of value.workers) worker.retirement?.resolve(0);
    await value.fleet.stop();
    for (const worker of value.workers) for (const control of worker.controls) control.port.close();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("storage fleet isolation and admission", () => {
  it("keeps another workspace and the local registry usable after A's active read times out", async () => {
    vi.useFakeTimers();
    const h = setup();
    h.blockedRoots.add(ROOT_A);
    const blocked = h.fleet.run("getPost", [ROOT_A, "stalled"], 10).catch((error: unknown) => error);
    await h.request((request) => request.name === "getPost" && request.args[1] === "stalled");
    await vi.advanceTimersByTimeAsync(10);
    expect(await blocked).toBeInstanceOf(Error);
    await expect(h.fleet.run("getPost", [ROOT_B, "readable"])).resolves.toBeNull();
    await expect(h.fleet.run("queueWorkspaceContent", ["b", "readable", "typed in B", EDITED_AT])).resolves.toBeNull();
    expect(await h.fleet.run("listWorkspaces", [])).toHaveLength(2);
    expect(await h.fleet.run("updateWorkspace", ["b", { name: "B renamed" }])).toMatchObject({ id: "b", name: "B renamed" });
    expect(h.workerAt(ROOT_A).requests.map((request) => request.name)).toEqual(["selectWorkspaceDirectory", "getPost"]);
    expect(h.workerAt(ROOT_B).requests.map((request) => request.name)).toContain("queueWorkspaceContent");
  });

  it("routes two aliases of one selected canonical root to one serialized writer after probing", async () => {
    const aliasA = path.resolve("/fleet/link-a");
    const aliasB = path.resolve("/fleet/link-b");
    const h = setup(new Map([[aliasA, ROOT_A], [aliasB, ROOT_A]]));
    h.blockedRoots.add(ROOT_A);
    const first = h.fleet.run("getPost", [aliasA, "one"]);
    const one = await h.request((request) => request.name === "getPost" && request.args[1] === "one");
    const second = h.fleet.run("getPost", [aliasB, "two"]);
    const probe = await h.request((request) => request.name === "selectWorkspaceDirectory" && request.args[0] === aliasB);
    await probe.worker.terminationStarted.promise;
    expect(probe.worker.requests.map((request) => request.name)).toEqual(["selectWorkspaceDirectory"]);
    expect(one.worker.requests.filter((request) => request.name === "getPost")).toHaveLength(1);
    one.worker.reply(one.request, null);
    await first;
    const two = await h.request((request) => request.name === "getPost" && request.args[1] === "two");
    expect(two.worker).toBe(one.worker);
    expect(two.request.args[0]).toBe(ROOT_A);
    two.worker.reply(two.request, null);
    await second;
    expect(h.workers.filter((worker) => worker.workspace)).toHaveLength(2);
    expect(probe.worker.terminateCalls).toBe(1);
  });

  it("refuses a third busy root without spawning replacement workers on retries", async () => {
    const h = setup();
    h.blockedRoots.add(ROOT_A).add(ROOT_B);
    const a = h.fleet.run("getPost", [ROOT_A, "a"]).catch((error: unknown) => error);
    const b = h.fleet.run("getPost", [ROOT_B, "b"]).catch((error: unknown) => error);
    await h.request((request) => request.name === "getPost" && request.args[1] === "a");
    await h.request((request) => request.name === "getPost" && request.args[1] === "b");
    for (const root of [ROOT_C, ROOT_C, path.resolve("/fleet/d")]) {
      await expect(h.fleet.run("getPost", [root, "third"])).rejects.toThrow(/capacity/);
    }
    expect(h.workers).toHaveLength(3); // local owner plus the two occupied roots
    expect(h.workers.every((worker) => worker.terminateCalls === 0)).toBe(true);
    h.workerAt(ROOT_A).reply(h.workerAt(ROOT_A).requests.at(-1)!, null);
    h.workerAt(ROOT_B).reply(h.workerAt(ROOT_B).requests.at(-1)!, null);
    await Promise.all([a, b]);
  });

  it("retains an idle executor with unsaved work and reuses its slot only after safe physical retirement", async () => {
    const h = setup();
    await h.fleet.run("getPost", [ROOT_A, "a"]);
    await h.fleet.run("getPost", [ROOT_B, "b"]);
    const a = h.workerAt(ROOT_A);
    const b = h.workerAt(ROOT_B);
    await expect(h.fleet.run("getPost", [ROOT_C, "blocked"])).rejects.toThrow(/capacity/);
    expect(a.requests.at(-1)?.name).toBe("canRetireWorkspace");
    expect(b.requests.at(-1)?.name).toBe("canRetireWorkspace");
    expect(a.terminateCalls).toBe(0);
    expect(b.terminateCalls).toBe(0);
    a.canRetire = true;
    a.retirement = deferred<number>();
    const replacement = h.fleet.run("getPost", [ROOT_C, "replacement"]);
    await Promise.race([a.terminationStarted.promise, replacement]);
    expect(h.workers).toHaveLength(3);
    expect(b.terminateCalls).toBe(0);
    a.retirement.resolve(0);
    await replacement;
    expect(h.workers).toHaveLength(4);
    expect(a.terminateCalls).toBe(1);
  });
});

describe("storage fleet shutdown", () => {
  it("bounds the aggregate asynchronous flush once for all stalled roots", async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.fleet.run("getPost", [ROOT_A, "a"]);
    await h.fleet.run("getPost", [ROOT_B, "b"]);
    let settled = false;
    const flushing = h.fleet.flushAsync(40).then((result) => { settled = true; return result; });
    expect(h.workerAt(ROOT_A).controls).toHaveLength(1);
    expect(h.workerAt(ROOT_B).controls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(39);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await flushing).toEqual({ kind: "expired" });
  });

  it("bounds all asynchronous finish requests and backup shutdown by one deadline", async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.fleet.run("listWorkspaces", []);
    await h.fleet.run("getPost", [ROOT_A, "a"]);
    await h.fleet.run("getPost", [ROOT_B, "b"]);
    const finishing = h.fleet.finishAsync(40, 100);
    expect(h.workers.every((worker) => worker.controls.some((request) => "finish" in request))).toBe(true);
    await vi.advanceTimersByTimeAsync(40);
    expect(await finishing).toBe(false);
    expect(h.stopBackups).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each(["flush", "finish"] as const)("gives synchronous %s waits only the remaining overall deadline", async (mode) => {
    const h = setup();
    await h.fleet.run("listWorkspaces", []);
    await h.fleet.run("getPost", [ROOT_A, "a"]);
    await h.fleet.run("getPost", [ROOT_B, "b"]);
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const waits: number[] = [];
    vi.spyOn(Atomics, "wait").mockImplementation((_signal, _index, _value, timeout) => {
      const expected = mode === "finish" ? h.workers : h.workers.filter((worker) => worker.workspace);
      expect(expected.every((worker) => worker.controls.length === 1)).toBe(true);
      waits.push(timeout!);
      now += timeout!;
      return "timed-out";
    });
    if (mode === "flush") expect(h.fleet.flushWithin(40)).toEqual({ kind: "expired" });
    else expect(h.fleet.finishWithin(40)).toBe(false);
    expect(waits).toEqual(mode === "flush" ? [40, 0] : [40, 0, 0]);
  });
});

describe("storage fleet notifications", () => {
  it("fans authored content events out to the workspace IDs resolved through the local registry", async () => {
    const alias = path.resolve("/fleet/alias-a");
    const h = setup(new Map([[alias, ROOT_A]]));
    h.workspaces.set("alias", { id: "alias", name: "Alias", dataDirectory: alias });
    const events = vi.fn();
    h.fleet.onContentSave(events);
    await h.fleet.run("queueWorkspaceContent", ["a", "post", "one", EDITED_AT]);
    await h.fleet.run("queueWorkspaceContent", ["alias", "post", "two", EDITED_AT]);
    await h.fleet.run("queueWorkspaceContent", ["b", "post", "other root", EDITED_AT]);
    h.workerAt(ROOT_A).emit("message", { event: "content-save", value: { kind: "post-missing", dataDir: ROOT_A, id: "post", wsId: "" } });
    expect(events.mock.calls.map(([event]) => event.wsId)).toEqual(["a", "alias"]);
    expect(h.workers[0]!.requests.filter((request) => request.name === "getWorkspace").map((request) => request.args[0])).toEqual(["a", "alias", "b"]);
  });

  it("forwards workspace diagnostics to the local owner and retains a forwarding health gap", async () => {
    const h = setup();
    await h.fleet.run("listWorkspaces", []);
    await h.fleet.run("getPost", [ROOT_A, "a"]);
    const health = vi.fn();
    const stored = vi.fn();
    h.fleet.onRecordsHealth(health);
    h.fleet.onRecordStored(stored);
    const record = { time: "2026-10-23T00:00:00.000Z", level: "warn", message: "workspace warning", workspaceId: "a", postId: null, event: '{"message":"workspace warning"}' };
    h.workerAt(ROOT_A).emit("message", { event: "forward-log", record, bytes: 32 });
    const log = await h.request((request) => request.name === "log");
    expect(log.worker).toBe(h.workers[0]);
    expect(log.request.args).toEqual([record]);
    h.workerAt(ROOT_A).emit("message", { event: "forward-log-gap" });
    h.workers[0]!.emit("message", { event: "records-health", value: { databaseGap: false, fallbackFailed: false, fallbackPath: "/fallback.jsonl" } });
    expect(h.fleet.recordsHealth()).toEqual({ databaseGap: true, fallbackFailed: true, fallbackPath: "/fallback.jsonl" });
    expect(health).toHaveBeenLastCalledWith(h.fleet.recordsHealth());
    h.workers[0]!.emit("message", { event: "record-stored" });
    expect(stored).toHaveBeenCalledOnce();
  });
});

it("quarantines a timed-out directory probe without accumulating a replacement for its alias", async () => {
  vi.useFakeTimers();
  const h = setup();
  h.blockedProbes.add(ROOT_A);
  const stalled = h.fleet.run("getPost", [ROOT_A, "probe"]).catch((error: unknown) => error);
  await h.request((request) => request.name === "selectWorkspaceDirectory" && request.args[0] === ROOT_A);
  await vi.advanceTimersByTimeAsync(STORAGE_WAIT_MS);
  expect(await stalled).toBeInstanceOf(Error);
  await expect(h.fleet.run("getPost", [ROOT_A, "retry"])).rejects.toThrow(/wait bound/);
  await h.fleet.run("getPost", [ROOT_B, "b"]);
  await expect(h.fleet.run("getPost", [ROOT_C, "c"])).rejects.toThrow(/capacity/);
  expect(h.workers).toHaveLength(3);
  expect(h.workerAt(ROOT_A).terminateCalls).toBe(0);
});

it("aggregates each workspace's authored flush failures", async () => {
  const h = setup();
  await h.fleet.run("getPost", [ROOT_A, "a"]);
  await h.fleet.run("getPost", [ROOT_B, "b"]);
  const flushing = h.fleet.flushAsync(1000);
  for (const [root, id] of [[ROOT_A, "a"], [ROOT_B, "b"]]) {
    const worker = h.workerAt(root!);
    worker.controls[0]!.port.postMessage({ failures: [{ id, message: `${id} still unsaved` }] });
    worker.emit("message", { event: "flush-settled" });
  }
  expect(await flushing).toEqual({ kind: "flushed", failures: [{ id: "a", message: "a still unsaved" }, { id: "b", message: "b still unsaved" }] });
});

it("retains a health gap when local forwarding of a workspace diagnostic fails", async () => {
  const h = setup();
  await h.fleet.run("listWorkspaces", []);
  await h.fleet.run("getPost", [ROOT_A, "a"]);
  h.heldCommands.add("log");
  const received = deferred<void>();
  h.fleet.onRecordsHealth(() => { received.resolve(); });
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const record = { time: "2026-10-23T00:00:00.000Z", level: "error", message: "workspace failure", workspaceId: "a", postId: null, event: '{"message":"workspace failure"}' };
  h.workerAt(ROOT_A).emit("message", { event: "forward-log", record, bytes: 32 });
  const log = await h.request((request) => request.name === "log");
  log.worker.emit("message", { id: log.request.id, ok: false, error: { name: "Error", message: "records unavailable" } });
  await received.promise;
  expect(h.fleet.recordsHealth()).toMatchObject({ databaseGap: true, fallbackFailed: true });
  expect(stderr).toHaveBeenCalledExactlyOnceWith(record.event);
});

describe("storage fleet pending scopes", () => {
  it("keeps registry preparation pending for the local scope until its actual worker result settles", async () => {
    vi.useFakeTimers();
    const h = setup();
    h.heldCommands.add("prepareWorkspace");
    let settled = false;
    const creating = h.fleet.run("createWorkspace", ["C", ROOT_C]).then((workspace) => { settled = true; return workspace; });
    const preparation = await h.request((request) => request.name === "prepareWorkspace");
    expect(h.fleet.storagePendingFor(null)).toBe(false);
    await vi.advanceTimersByTimeAsync(STORAGE_WAIT_MS);
    expect(settled).toBe(false);
    expect(h.fleet.storagePendingFor(null)).toBe(true);
    expect(h.fleet.storagePendingFor("a")).toBe(true);
    const prepared: Workspace = { id: "c", name: "C", dataDirectory: ROOT_C };
    preparation.worker.reply(preparation.request, prepared);
    expect(await creating).toEqual(prepared);
    expect(h.fleet.storagePendingFor(null)).toBe(false);
    expect(h.fleet.storagePendingFor("a")).toBe(false);
  });

  it("scopes an ordinary pending mutation to its canonical workspace without blocking B or local operations", async () => {
    vi.useFakeTimers();
    const h = setup();
    await h.fleet.run("queueWorkspaceContent", ["a", "post", "A buffer", EDITED_AT]);
    await h.fleet.run("queueWorkspaceContent", ["b", "post", "B buffer", EDITED_AT]);
    h.heldCommands.add("setLocked");
    const mutation = h.fleet.run("setLocked", [ROOT_A, "post", true], 10);
    const request = await h.request((request) => request.name === "setLocked");
    await vi.advanceTimersByTimeAsync(10);
    expect(h.fleet.storagePendingFor("a")).toBe(true);
    expect(h.fleet.storagePendingFor("b")).toBe(false);
    expect(h.fleet.storagePendingFor(null)).toBe(false);
    await expect(h.fleet.run("getPost", [ROOT_B, "post"])).resolves.toBeNull();
    await expect(h.fleet.run("updateWorkspace", ["b", { name: "B still usable" }])).resolves.toMatchObject({ name: "B still usable" });
    request.worker.reply(request.request, null);
    await mutation;
    expect(h.fleet.storagePendingFor("a")).toBe(false);
    expect(h.fleet.storagePendingFor("b")).toBe(false);
    expect(h.fleet.storagePendingFor(null)).toBe(false);
  });
});
