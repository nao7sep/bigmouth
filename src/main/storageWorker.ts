import { parentPort } from "node:worker_threads";
import { storageTasks } from "./storageTasks.js";
import { setContentSaveListener } from "./core/services/postStore.js";
import { onRecordStored } from "./core/services/recordsStore.js";
import { serializeError } from "./core/services/logger.js";
import type { StorageRequest, StorageReply, StorageFlushRequest, StorageFinishRequest } from "./storageOwner.js";

const port = parentPort!;
function apply(request: StorageRequest) {
  const value = (storageTasks[request.name] as (...args: unknown[]) => unknown)(...request.args);
  port.postMessage({ id: request.id, ok: true, value } satisfies StorageReply);
  return value;
}
setContentSaveListener((value) => {
  const event = value.kind === "save-failed" ? { ...value, error: serializeError(value.error) } : value;
  port.postMessage({ event: "content-save", value: event } satisfies StorageReply);
});
onRecordStored(() => port.postMessage({ event: "record-stored" } satisfies StorageReply));
port.on("message", (request: StorageRequest | StorageFlushRequest | StorageFinishRequest) => {
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
      finally { storageTasks.finish(); }
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
        if (!["queueContent", "queueMetadata", "queueWorkspaceContent", "queueWorkspaceMetadata"].includes(edit.name)) continue;
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
