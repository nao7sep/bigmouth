// Replies that its work failed, as the quit flush worker does when it throws.
import { workerData, type MessagePort } from "node:worker_threads";

const { signal, port } = workerData as { signal: Int32Array; port: MessagePort };
port.postMessage({ ok: false, error: "the storage root could not be used" });
Atomics.store(signal, 0, 1);
Atomics.notify(signal, 0);
