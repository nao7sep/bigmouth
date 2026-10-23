import { onDurabilityUnconfirmed } from "./core/shared/publication.js";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { listWorkspaces, onWorkspaceRegistryChanged } from "./core/services/workspaceStore.js";
import { storageTasks } from "./storageTasks.js";
import { setContentSaveListener } from "./core/services/postStore.js";
import { onRecordStored, onRecordsHealth } from "./core/services/recordsStore.js";
import { configureBackupRelay, isBackupRelayIdle, useBackupRecorderModule } from "./core/services/backupStore.js";
import { serializeError, setLogSink } from "./core/services/logger.js";
import { WORKER_ENTRIES } from "./builtEntries.js";
import type { StorageRequest, StorageReply, StorageFlushRequest, StorageFinishRequest } from "./storageOwner.js";

const port = parentPort!;
export interface StorageWorkerData {
  workspace: boolean;
  backupPort: MessagePort;
  backupLimits: { bytes: number; descriptors: number };
  logBudget: Int32Array;
}
const options = workerData as StorageWorkerData | undefined;
if (options?.backupPort) configureBackupRelay(options.backupPort, options.backupLimits);
if (options?.workspace) {
  let reportedGap = false;
  setLogSink((record) => {
    const bytes = 1024 + record.event.length * 2;
    let available = Atomics.load(options.logBudget, 0);
    while (available >= bytes) {
      const previous = Atomics.compareExchange(options.logBudget, 0, available, available - bytes);
      if (previous === available) {
        try { port.postMessage({ event: "forward-log", record, bytes } satisfies StorageReply); return; }
        catch { Atomics.add(options.logBudget, 0, bytes); }
        break;
      }
      available = previous;
    }
    if (!reportedGap) {
      reportedGap = true;
      try { port.postMessage({ event: "forward-log-gap" } satisfies StorageReply); }
      catch { /* The console still receives the original immutable event. */ }
    }
    console.error(record.event);
  });
}
// electron-vite builds the backup recorder as its own entry beside this one.
const here = import.meta.url;
if (here && !here.endsWith(".ts")) useBackupRecorderModule(new URL(`./${WORKER_ENTRIES.backup}.js`, here));
function apply(request: StorageRequest) {
  const value = request.name === "canRetireWorkspace"
    ? storageTasks.canRetireWorkspace() && isBackupRelayIdle()
    : (storageTasks[request.name] as (...args: unknown[]) => unknown)(...request.args);
  port.postMessage({ id: request.id, ok: true, value } satisfies StorageReply);
  return value;
}
setContentSaveListener((value) => {
  const event = value.kind === "save-failed" ? { ...value, error: serializeError(value.error) } : value;
  if (options?.workspace) {
    port.postMessage({ event: "content-save", value: { ...event, wsId: "" } } satisfies StorageReply);
    return;
  }
  // The registry is already cached by workspace resolution; aliases receive the
  // same physical save with their own identity, without another file read.
  for (const workspace of listWorkspaces()) {
    if (workspace.dataDirectory === value.dataDir) {
      port.postMessage({ event: "content-save", value: { ...event, wsId: workspace.id } } satisfies StorageReply);
    }
  }
});
onDurabilityUnconfirmed(() => port.postMessage({ event: "durability-unconfirmed" } satisfies StorageReply));
onRecordsHealth((value) => port.postMessage({ event: "records-health", value } satisfies StorageReply));
onWorkspaceRegistryChanged(() => port.postMessage({ event: "record-sources-changed" } satisfies StorageReply));
onRecordStored(() => port.postMessage({ event: "record-stored" } satisfies StorageReply));
// A request that could not be read is said to be, so the owner fails it rather
// than waiting for a reply that cannot come.
port.on("messageerror", () => port.postMessage({ event: "request-unreadable" } satisfies StorageReply));
port.on("message", async (request: StorageRequest | StorageFlushRequest | StorageFinishRequest) => {
  if ("finish" in request) {
    try {
      for (const queued of request.queued) {
        try {
          const value = (storageTasks[queued.name] as (...args: unknown[]) => unknown)(...queued.args);
          port.postMessage({ id: queued.id, ok: true, value } satisfies StorageReply);
        } catch (error) { port.postMessage({ id: queued.id, ok: false, error: serializeError(error) } as StorageReply); }
      }
      // Edits that reached the buffer after the last quit flush, such as those
      // typed while the quit question was open, get one more write attempt
      // within the finish bound; a quit flush already held the debounce.
      try { storageTasks.flush(); }
      finally { await storageTasks.finish(request.backupBoundMs); }
    }
    finally {
      request.port.postMessage({ finished: true });
      Atomics.store(request.signal, 0, 1);
      Atomics.notify(request.signal, 0);
      request.port.close();
    }
    return;
  }
  if ("flush" in request) {
    const failures: { id: string; message: string }[] = [];
    storageTasks.holdPendingFlushes();
    for (const edit of request.edits) {
      try {
        if (!["queueWorkspaceContent", "queueWorkspaceMetadata"].includes(edit.name)) continue;
        const result = apply(edit);
        if (result !== null && !edit.name.endsWith("Content")) failures.push({ id: String(edit.args[1]), message: "The metadata edit could not be saved." });
      } catch (error) {
        failures.push({ id: String(edit.args[1]), message: "The edit could not reach storage." });
        port.postMessage({ id: edit.id, ok: false, error: serializeError(error) } as StorageReply);
      }
    }
    failures.push(...storageTasks.flush());
    request.port.postMessage({ failures });
    Atomics.store(request.signal, 0, 1);
    Atomics.notify(request.signal, 0);
    request.port.close();
    port.postMessage({ event: "flush-settled" } satisfies StorageReply);
    return;
  }
  try {
    apply(request);
  } catch (error) {
    port.postMessage({ id: request.id, ok: false, error: serializeError(error) } as StorageReply);
  }
});
