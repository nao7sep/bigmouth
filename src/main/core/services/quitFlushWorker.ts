// The quit flush's thread (quitFlush.ts): it buffers the edits it is given and
// writes them with the post store's own flush, so a stalled disk blocks this
// thread and not the quit. Its log records join the app's session, and its
// managed writes are recorded in the backup store like any other.

import { workerData } from "node:worker_threads";

import { adoptPendingEdits, flushAllPendingEdits, holdPendingFlushes, setContentSaveListener, type ContentSaveEvent } from "./postStore.js";
import { closeBackupStore } from "./backupStore.js";
import { serializeError } from "./logger.js";
import { closeRecords, openRecords } from "./recordsStore.js";
import { getLogsDir, getRecordsDbPath, initStorageRoot } from "./storagePaths.js";
import type { BoundedWorkerData, BoundedWorkerReply, QuitFlushReply, QuitFlushRequest } from "./quitFlush.js";

const { request, signal, port } = workerData as BoundedWorkerData<QuitFlushRequest>;

let reply: BoundedWorkerReply;
try {
  initStorageRoot();
  if (request.recordsSession !== null) {
    openRecords(getRecordsDbPath(), getLogsDir(), new Date(request.recordsSession));
  }
  const events: ContentSaveEvent[] = [];
  // A failure's error crosses to the app as its logged form, which any thread can carry.
  setContentSaveListener((event) =>
    events.push(event.kind === "save-failed" ? { ...event, error: serializeError(event.error) } : event),
  );
  // A failed write is retried by the app's own buffer, never from here.
  holdPendingFlushes();
  adoptPendingEdits(request.edits);
  const failures = flushAllPendingEdits();
  reply = { ok: true, value: { failures, events } satisfies QuitFlushReply };
} catch (error: unknown) {
  reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
} finally {
  closeBackupStore();
  closeRecords();
}
port.postMessage(reply);
Atomics.store(signal, 0, 1);
Atomics.notify(signal, 0);
