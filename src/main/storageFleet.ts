import os from "node:os";
import path from "node:path";
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import type { StorageOwner, StorageCommand, StorageFlushOutcome, StorageRequest, WorkspaceContentSaveEvent } from "./storageOwner.js";
import type { StorageTasks } from "./storageTasks.js";
import type { StorageWorkerData } from "./storageWorker.js";
import type { Workspace } from "@shared/types";
import type { RecordsHealth } from "@shared/records";
import { message } from "@shared/i18n/translate";
import { attachBackupRelay, beginBackupShutdown, stopBackups, useBackupRecorderModule } from "./core/services/backupStore.js";
import { DEBUG_LOG_FLAG } from "./core/services/logger.js";
import { WORKER_ENTRIES } from "./builtEntries.js";
import { StorageAdmission } from "./storageAdmission.js";

const directoryCommands = new Set<StorageCommand>([
  "getWorkspaceConfig", "getSettings", "getConfigNotice", "saveSettings", "getTargets", "saveTargets",
  "getAnalysisPrompts", "saveAnalysisPrompts", "getGenerationPrompts", "saveGenerationPrompts",
  "clearCache", "rebuildIndex", "flushPostEdits", "getPost", "createPost", "updatePost", "changeStatus",
  "setLocked", "deletePost", "listReferrers", "postExists", "renameTarget", "refreshIndex", "listByStatus",
  "countByStatus", "listAssets", "installAsset", "deleteAsset",
]);
interface Entry { owner: StorageOwner; root: string | null; users: number; retiring: Promise<void> | null; keys: Set<string> }
export interface StorageFleetOptions {
  capacity?: number;
  createOwner?: (workspace: boolean) => StorageOwner;
  stopBackups?: (boundMs: number) => Promise<void>;
}

/** Each selected physical root keeps one executor and edit buffer; app-local files have their own owner. */
export function createStorageFleet(Owner: typeof StorageOwner, options: StorageFleetOptions = {}) {
  return new StorageFleet(Owner, options);
}

class StorageFleet {
  private readonly local: StorageOwner;
  private readonly slots = new Set<Entry>();
  private readonly bindings = new Map<string, Promise<Entry>>();
  private readonly roots = new Map<string, Entry>();
  private readonly workspaceRoots = new Map<string, string>();
  private readonly workspaceDirectories = new Map<string, string>();
  private readonly capacity: number;
  private readonly makeOwner: (workspace: boolean) => StorageOwner;
  private readonly stopRecorder: (boundMs: number) => Promise<void>;
  private readonly sealRecorder: () => void;
  private readonly logBudget = new Int32Array(new SharedArrayBuffer(4));
  private contentListener: ((event: WorkspaceContentSaveEvent) => void) | null = null;
  private failureListener: ((request: StorageRequest, error: unknown) => void) | null = null;
  private pendingListener: ((pending: boolean) => void) | null = null;
  private durabilityListener: (() => void) | null = null;
  private healthListener: ((health: RecordsHealth) => void) | null = null;
  private unconfirmed = false;
  private forwardingGap = false;
  private closing = false;
  private registrations: Promise<unknown> = Promise.resolve();
  private routing = new Set<Promise<unknown>>();
  private readonly admission = new StorageAdmission(Math.floor(os.totalmem() / 256));
  private sequence = 0;
  private authoredRouting = new Map<number, { wsId: string; postId: string }>();
  private registrationOwners = new Set<StorageOwner>();

  constructor(Owner: typeof StorageOwner, options: StorageFleetOptions) {
    // One core per active filesystem executor, with a modest per-isolate memory
    // allowance. Occupied/stalled slots are never replaced until they retire.
    this.capacity = options.capacity ?? Math.max(2, Math.min(os.availableParallelism(), Math.floor(os.totalmem() / (128 * 1024 * 1024))));
    Atomics.store(this.logBudget, 0, Math.min(2 ** 30, Math.floor(os.totalmem() / 256)));
    this.stopRecorder = options.stopBackups ?? stopBackups;
    this.sealRecorder = options.stopBackups ? () => {} : beginBackupShutdown;
    this.makeOwner = options.createOwner ?? ((workspace) => new Owner(() => {
      const source = import.meta.url.endsWith(".ts");
      if (!source) useBackupRecorderModule(new URL(`./${WORKER_ENTRIES.backup}.js`, import.meta.url));
      const { port1, port2 } = new MessageChannel();
      attachBackupRelay(port1);
      const workerData: StorageWorkerData = {
        workspace, backupPort: port2, logBudget: this.logBudget,
        backupLimits: {
          bytes: Math.floor(os.totalmem() / 256 / (this.capacity + 1)),
          descriptors: Math.max(1, Math.floor(os.availableParallelism() * 8 / (this.capacity + 1))),
        },
      };
      try {
        return new Worker(new URL(source ? "./storageWorker.ts" : `./${WORKER_ENTRIES.storage}.js`, import.meta.url), {
          workerData, transferList: [port2], argv: process.argv.filter((arg) => arg === DEBUG_LOG_FLAG),
          // A broker may still read a pinned descriptor if its opening worker
          // crashes. Never let Node close/reuse it underneath that read. Failed
          // owners stay quarantined; exceptional orphan handles end at process
          // exit, bounded by the occupied slots and their admission quotas.
          trackUnmanagedFds: false,
        });
      } catch (error) { port1.close(); port2.close(); throw error; }
    }, Math.floor(os.totalmem() / 256 / (this.capacity + 1))));
    this.local = this.makeOwner(false);
    this.observe(this.local);
    this.local.onRecordsHealth(() => this.healthListener?.(this.recordsHealth()));
  }

  private observe(owner: StorageOwner): void {
    owner.onStoragePending(() => {
      if (!owner.storagePending()) this.registrationOwners.delete(owner);
      this.pendingListener?.(this.storagePending());
    });
    owner.onDurabilityUnconfirmed(() => { this.unconfirmed = true; this.durabilityListener?.(); });
    owner.onHeldEditFailed((request, error) => this.failureListener?.(request, error));
    owner.onContentSave((event) => {
      if (event.wsId) { this.contentListener?.(event); return; }
      for (const [wsId, root] of this.workspaceRoots) {
        if (root === event.dataDir) this.contentListener?.({ ...event, wsId });
      }
    });
    owner.onForwardLog((event) => {
      const gap = () => { this.forwardingGap = true; this.healthListener?.(this.recordsHealth()); };
      if (event.event === "forward-log-gap") { gap(); return; }
      void this.local.runOwned("log", [event.record]).catch(() => { gap(); console.error(event.record.event); })
        .finally(() => Atomics.add(this.logBudget, 0, event.bytes));
    });
  }

  private async retire(entry: Entry): Promise<void> {
    entry.retiring = entry.owner.stop();
    await entry.retiring;
    this.slots.delete(entry);
    if (entry.root && this.roots.get(entry.root) === entry) this.roots.delete(entry.root);
    // Remove aliases only after physical retirement; requests awaiting an alias
    // will retry through acquisition rather than creating a competing writer.
    for (const key of entry.keys) this.bindings.delete(key);
  }

  private async makeRoom(): Promise<void> {
    if (this.slots.size < this.capacity) return;
    for (const entry of this.slots) {
      if (entry.users || entry.retiring || !entry.owner.isIdle()) continue;
      // This query is I/O-free on the worker. A blocked debounce cannot be
      // evicted merely because the main thread has no request in flight.
      const safe = await entry.owner.runOwned("canRetireWorkspace", []).catch(() => false);
      if (!safe || entry.users || !entry.owner.isIdle()) continue;
      await this.retire(entry);
      if (this.slots.size < this.capacity) return;
    }
    throw new Error("Workspace storage capacity is occupied by pending work. Try again after it settles.");
  }

  private async createEntry(directory: string): Promise<Entry> {
    await this.makeRoom();
    // Admission can interleave while an idle owner is retiring.
    if (this.slots.size >= this.capacity) throw new Error("Workspace storage capacity is occupied by pending work.");
    const entry: Entry = { owner: this.makeOwner(true), root: null, users: 0, retiring: null, keys: new Set([directory]) };
    this.slots.add(entry);
    this.observe(entry.owner);
    try {
      entry.root = await entry.owner.runOwned("selectWorkspaceDirectory", [directory]);
      const prior = this.roots.get(entry.root);
      if (prior) {
        await this.retire(entry);
        if (prior.retiring) { await prior.retiring; return this.createEntry(directory); }
        prior.keys.add(directory);
        this.bindings.set(directory, Promise.resolve(prior));
        return prior;
      }
      this.roots.set(entry.root, entry);
      return entry;
    } catch (error) {
      // A timed-out path probe can still own native I/O. Keep its finite slot
      // quarantined; stop/quit observes physical retirement, never replacement.
      if (entry.owner.isIdle()) await this.retire(entry);
      throw error;
    }
  }

  private async acquire(directory: string): Promise<Entry> {
    const key = path.resolve(directory);
    let pending = this.bindings.get(key);
    if (!pending) {
      pending = this.createEntry(key);
      this.bindings.set(key, pending);
      const submitted = pending;
      void pending.catch(() => {
        if (![...this.slots].some((entry) => entry.keys.has(key)) && this.bindings.get(key) === submitted) this.bindings.delete(key);
      });
      // A failed probe stays associated with this selected root for the launch.
      // Retrying it must not accumulate workers against the same stalled path.
    }
    const entry = await pending;
    if (entry.retiring) {
      await entry.retiring;
      if (this.bindings.get(key) === pending) this.bindings.delete(key);
      return this.acquire(key);
    }
    entry.users++;
    return entry;
  }

  private async atDirectory(directory: string, operation: (owner: StorageOwner, root: string) => Promise<unknown>, wsId?: string): Promise<unknown> {
    const entry = await this.acquire(directory);
    for (const [id, selected] of this.workspaceDirectories) {
      if (path.resolve(selected) === path.resolve(directory)) this.workspaceRoots.set(id, entry.root!);
    }
    if (wsId) this.workspaceRoots.set(wsId, entry.root!);
    try { return await operation(entry.owner, entry.root!); }
    finally { entry.users--; }
  }

  run<K extends StorageCommand>(name: K, args: Parameters<StorageTasks[K]>, boundMs?: number): Promise<ReturnType<StorageTasks[K]>> {
    if (this.closing) return Promise.reject(new Error("Storage is closing."));
    const id = ++this.sequence;
    if (!this.admission.reserve(id, args)) return Promise.reject(new Error("Storage cannot accept more pending work until its earlier operations settle. This operation was not accepted."));
    let snapshot: unknown[];
    try { snapshot = structuredClone(args); }
    catch (error) { this.admission.release(id); return Promise.reject(error); }
    if (name === "queueWorkspaceContent") this.authoredRouting.set(id, { wsId: String(args[0]), postId: String(args[1]) });
    const pending = this.route(name, snapshot, boundMs);
    this.routing.add(pending);
    void pending.finally(() => { this.routing.delete(pending); this.authoredRouting.delete(id); this.admission.release(id); }).catch(() => {});
    return pending as Promise<ReturnType<StorageTasks[K]>>;
  }

  private async route(name: StorageCommand, args: unknown[], boundMs?: number): Promise<unknown> {
    const local = (command: StorageCommand, values: unknown[]) => this.local.runOwned(command, values as never, boundMs);
    if (name === "initialize") {
      const initialized = await this.local.runOwned("initialize", args as never, boundMs);
      for (const ws of initialized.config.workspaces) this.workspaceDirectories.set(ws.id, ws.dataDirectory);
      return initialized;
    }
    if (name === "getWorkspace") {
      const ws = await this.local.runOwned("getWorkspace", args as never, boundMs);
      if (ws) this.workspaceDirectories.set(ws.id, ws.dataDirectory);
      return ws;
    }
    if (directoryCommands.has(name)) {
      return this.atDirectory(String(args[0]), (owner, root) => owner.runOwned(name, [root, ...args.slice(1)] as never, boundMs));
    }
    if (name === "queueWorkspaceContent" || name === "queueWorkspaceMetadata") {
      const ws = await this.local.runOwned("getWorkspace", [String(args[0])]);
      if (!ws) throw new Error("Workspace not found");
      return this.atDirectory(ws.dataDirectory, (owner) => owner.runOwned(name, args as never, boundMs), ws.id);
    }
    if (name === "getRoleCall" || name === "getAnthropicSettingsForClient" || name === "saveAnthropicSettings") {
      const ws = args[0] as Workspace;
      return this.atDirectory(ws.dataDirectory, async (owner, root) => {
        if (name === "getRoleCall") {
          const [config, apiKey] = await Promise.all([owner.runOwned("getRoleConfig", [root, args[1]] as never), this.local.runOwned("resolveAnthropicKey", [ws.id])]);
          return { ...config, apiKey };
        }
        let movedTo: string | null = null;
        let config;
        if (name === "saveAnthropicSettings") {
          const input = args[1] as Parameters<StorageTasks["saveAnthropicSettings"]>[1];
          movedTo = await this.local.runOwned("saveAnthropicKey", [ws.id, input.apiKey ?? ""]);
          const { apiKey: _key, ...sets } = input;
          config = await owner.runOwned("saveAnthropicConfig", [root, sets]);
        } else config = await owner.runOwned("getAnthropicConfigForClient", [root]);
        const keys = await this.local.runOwned("getAnthropicKeyState", [ws.id]);
        return { ...config, ...keys, ...(movedTo ? { keyNotice: message("settings.keyFileMovedAside", { path: movedTo }) } : {}) };
      }, ws.id);
    }
    if (name === "createWorkspace" || name === "addExistingWorkspace") {
      // Registry additions serialize their prepare/commit decisions. Existing
      // workspace work and local rename/remove/read operations do not join it.
      const result = this.registrations.catch(() => {}).then(async () => {
        const registered = await this.local.runOwned("listWorkspaces", []);
        const directory = name === "createWorkspace"
          ? (args[1] as string | undefined) ?? await this.local.runOwned("suggestWorkspaceLocation", [])
          : String(args[0]);
        const prepared = await this.atDirectory(directory, async (owner, root) => {
          this.registrationOwners.add(owner);
          try {
            return await (name === "createWorkspace"
              ? owner.runOwned("prepareWorkspace", [String(args[0]), root, registered])
              : owner.runOwned("prepareExistingWorkspace", [root, registered, path.basename(directory)]));
          } finally {
            if (!owner.storagePending()) this.registrationOwners.delete(owner);
            this.pendingListener?.(this.storagePending());
          }
        }) as Workspace;
        const wasRegistered = registered.some((ws) => ws.id === prepared.id);
        if (wasRegistered && !await this.local.runOwned("getWorkspace", [prepared.id])) {
          throw new Error("That workspace was removed while its folder was being opened.");
        }
        const workspace = await this.local.runOwned("registerPreparedWorkspace", [wasRegistered ? prepared : { ...prepared, dataDirectory: directory }]);
        this.workspaceDirectories.set(workspace.id, workspace.dataDirectory);
        return workspace;
      });
      this.registrations = result;
      return result;
    }
    if (name === "deleteWorkspace") {
      const result = await local(name, args);
      // Removing the registry entry must not discard buffered authored work.
      // Its executor remains until it has settled, or bounded process shutdown.
      return result;
    }
    if (name === "fileExists" || name === "readSourceMetadata") {
      if (typeof args[0] !== "string" || !path.isAbsolute(args[0])) return name === "fileExists" ? false : undefined;
      return this.atDirectory(path.dirname(args[0]), (owner) => owner.runOwned(name, args as never, boundMs));
    }
    if (name === "holdPendingFlushes" || name === "resumePendingFlushes") {
      await Promise.all([...this.slots].map(({ owner }) => owner.runOwned(name, [])));
      return;
    }
    return local(name, args);
  }

  onContentSave(listener: typeof this.contentListener): void { this.contentListener = listener; }
  onHeldEditFailed(listener: typeof this.failureListener): void { this.failureListener = listener; }
  onStoragePending(listener: typeof this.pendingListener): void { this.pendingListener = listener; }
  storagePending(): boolean { return this.local.storagePending() || [...this.slots].some(({ owner }) => owner.storagePending()); }
  storagePendingFor(wsId: string | null): boolean {
    if (this.local.storagePending() || [...this.registrationOwners].some((owner) => owner.storagePending())) return true;
    const root = wsId ? this.workspaceRoots.get(wsId) : undefined;
    return root ? this.roots.get(root)?.owner.storagePending() ?? false : false;
  }
  holdsContentFor(wsId: string, postId: string): boolean {
    return [...this.authoredRouting.values()].some((edit) => edit.wsId === wsId && edit.postId === postId)
      || [...this.slots].some(({ owner }) => owner.holdsContentFor(wsId, postId));
  }
  onDurabilityUnconfirmed(listener: typeof this.durabilityListener): void { this.durabilityListener = listener; }
  durabilityUnconfirmed(): boolean { return this.unconfirmed; }
  onRecordsHealth(listener: typeof this.healthListener): void { this.healthListener = listener; }
  recordsHealth(): RecordsHealth {
    const local = this.local.recordsHealth();
    return { ...local, databaseGap: local.databaseGap || this.forwardingGap, fallbackFailed: local.fallbackFailed || this.forwardingGap };
  }
  onRecordStored(listener: (() => void) | null): void { this.local.onRecordStored(listener); }
  onRecordSourcesChanged(listener: (() => void) | null): void { this.local.onRecordSourcesChanged(listener); }

  async flushAsync(boundMs: number): Promise<StorageFlushOutcome> {
    const deadline = performance.now() + boundMs;
    for (;;) {
      const results = await Promise.all([...this.slots].map(({ owner }) => owner.flushAsync(Math.max(0, deadline - performance.now()))));
      const failure = results.find((result) => result.kind !== "flushed");
      if (failure) return failure;
      const failures = results.flatMap((result) => result.kind === "flushed" ? result.failures : []);
      if (failures.length || !this.routing.size) return { kind: "flushed", failures };
      const remaining = deadline - performance.now();
      if (remaining <= 0) return { kind: "expired" };
      // Preparations already admitted may deliver an edit after the first pass.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.allSettled([...this.routing]), new Promise((resolve) => { timer = setTimeout(resolve, remaining); })]);
      } finally { clearTimeout(timer); }
    }
  }

  flushWithin(boundMs: number): StorageFlushOutcome {
    const deadline = performance.now() + boundMs;
    const failures: { id: string; message: string }[] = [];
    const started = [...this.slots].map(({ owner }) => {
      try { return owner.beginFlush(); } catch { return null; }
    });
    let expired = this.routing.size > 0;
    for (const pending of started) {
      if (!pending) { expired = true; continue; }
      Atomics.wait(pending.signal, 0, 0, Math.max(0, deadline - performance.now()));
      const reply = receiveMessageOnPort(pending.port)?.message as { failures: { id: string; message: string }[] } | undefined;
      pending.port.close();
      if (reply) failures.push(...reply.failures); else expired = true;
    }
    return expired ? { kind: "expired" } : { kind: "flushed", failures };
  }

  async finishAsync(boundMs: number, backupBoundMs: number): Promise<boolean> {
    this.closing = true;
    const deadline = performance.now() + boundMs;
    const owners = [this.local, ...[...this.slots].map(({ owner }) => owner)];
    const done = await Promise.all(owners.map((owner) => owner.finishAsync(Math.max(0, deadline - performance.now()), backupBoundMs)));
    this.sealRecorder();
    const recorder = this.stopRecorder(Math.min(backupBoundMs, Math.max(0, deadline - performance.now())));
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), Math.max(0, deadline - performance.now()));
      void recorder.then(() => { clearTimeout(timer); resolve(done.every(Boolean) && this.routing.size === 0); }, () => { clearTimeout(timer); resolve(false); });
    });
  }

  finishWithin(boundMs: number): boolean {
    this.closing = true;
    const deadline = performance.now() + boundMs;
    const started = [this.local, ...[...this.slots].map(({ owner }) => owner)].map((owner) => owner.beginFinish(0));
    this.sealRecorder();
    void this.stopRecorder(0);
    let settled = this.routing.size === 0;
    for (const pending of started) {
      if (!pending) continue;
      if (Atomics.wait(pending.signal, 0, 0, Math.max(0, deadline - performance.now())) === "timed-out") settled = false;
      pending.port.close();
    }
    return settled;
  }

  async stop(): Promise<void> {
    this.closing = true;
    this.sealRecorder();
    // Broker retirement releases pinned descriptors before their opening
    // threads retire. A blocked broker keeps the owners quarantined until exit.
    await this.stopRecorder(0);
    await Promise.all([this.local.stop(), ...[...this.slots].map(({ owner }) => owner.stop())]);
  }
}
