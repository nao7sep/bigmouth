import { parentPort } from "node:worker_threads";
import { listWorkspaces } from "./core/services/workspaceStore.js";
import { storageTasks } from "./storageTasks.js";
import { setContentSaveListener } from "./core/services/postStore.js";
import { onRecordStored, onRecordsHealth } from "./core/services/recordsStore.js";
import { useBackupRecorderModule } from "./core/services/backupStore.js";
import { error as logError, serializeError } from "./core/services/logger.js";
import { WORKER_ENTRIES } from "./builtEntries.js";
import type { StorageRequest, StorageReply, StorageFinishRequest } from "./storageOwner.js";

const port = parentPort!;
// electron-vite builds the backup recorder as its own entry beside this one.
const here = import.meta.url;
if (here && !here.endsWith(".ts")) useBackupRecorderModule(new URL(`./${WORKER_ENTRIES.backup}.js`, here));
function apply(request: StorageRequest): void {
  const value = (storageTasks[request.name] as (...args: unknown[]) => unknown)(...request.args);
  port.postMessage({ id: request.id, ok: true, value } satisfies StorageReply);
}
setContentSaveListener((value) => {
  const event = value.kind === "save-failed" ? { ...value, error: serializeError(value.error) } : value;
  // The registry is already cached by workspace resolution; aliases receive the
  // same physical save with their own identity, without another file read.
  for (const workspace of listWorkspaces()) {
    if (workspace.dataDirectory === value.dataDir) {
      port.postMessage({ event: "content-save", value: { ...event, wsId: workspace.id } } satisfies StorageReply);
    }
  }
});
onRecordsHealth((value) => port.postMessage({ event: "records-health", value } satisfies StorageReply));
onRecordStored(() => port.postMessage({ event: "record-stored" } satisfies StorageReply));
// A request that could not be read is said to be, so the owner fails it rather
// than waiting for a reply that cannot come.
port.on("messageerror", () => port.postMessage({ event: "request-unreadable" } satisfies StorageReply));
port.on("message", async (request: StorageRequest | StorageFinishRequest) => {
  if ("finish" in request) {
    try {
      for (const queued of request.queued) {
        try {
          const value = (storageTasks[queued.name] as (...args: unknown[]) => unknown)(...queued.args);
          port.postMessage({ id: queued.id, ok: true, value } satisfies StorageReply);
        } catch (error) { port.postMessage({ id: queued.id, ok: false, error: serializeError(error) } as StorageReply); }
      }
      // Edits that reached the buffer after the quit's flush, such as those
      // typed while the quit question was open, get one more write attempt. The
      // records close after this, so a failure is logged here, where it can be.
      try {
        const failures = storageTasks.flush();
        if (failures.length > 0) logError("pending edits flush failed at quit", { failures });
      }
      // The storage finish says it is done only once the recorder has stopped; the exit deadline
      // the main process holds over it ends the process when it has not.
      finally { await storageTasks.finish(request.drainBackups); }
    }
    finally {
      request.port.postMessage({ finished: true });
      Atomics.store(request.signal, 0, 1);
      Atomics.notify(request.signal, 0);
      request.port.close();
    }
    return;
  }
  try {
    apply(request);
  } catch (error) {
    port.postMessage({ id: request.id, ok: false, error: serializeError(error) } as StorageReply);
  }
});
