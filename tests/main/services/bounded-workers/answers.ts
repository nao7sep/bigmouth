// Replies with the request it was given, as the quit flush worker replies.
import { workerData, type MessagePort } from "node:worker_threads";

const { request, signal, port } = workerData as { request: unknown; signal: Int32Array; port: MessagePort };
port.postMessage({ ok: true, value: request });
Atomics.store(signal, 0, 1);
Atomics.notify(signal, 0);
