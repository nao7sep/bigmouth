import fs from "node:fs";
import type { MessagePort } from "node:worker_threads";
import { BackupAdmission } from "./backupAdmission.js";
import type { BackupWrite } from "./backupWorker.js";

export interface BackupRelayRequest { write: BackupWrite; release: Int32Array }

// Node supports waitAsync at the runtime floor; the shared TS target is ES2022.
const asyncAtomics = Atomics as typeof Atomics & {
  waitAsync(array: Int32Array, index: number, value: number):
    | { async: false; value: string }
    | { async: true; value: Promise<string> };
};

function releaseOrigin(write: BackupWrite): void {
  if (write.kind === "record-file") {
    try { fs.closeSync(write.fd); } catch { /* This origin no longer retains the version. */ }
  }
}

/** The origin owns file descriptors until the broker has physically released its lease. */
export class BackupRelay {
  private readonly queue: BackupAdmission;
  private stopped = false;
  private readonly idleWaiters = new Set<() => void>();

  constructor(
    private readonly port: MessagePort,
    limits: { bytes: number; descriptors: number },
    private readonly warn: (message: string, error?: unknown) => void,
  ) {
    this.queue = new BackupAdmission(limits, (write, signal) => this.send(write, signal), releaseOrigin,
      () => warn("backup relay is full; some saved versions could not be retained"));
    port.on("close", () => {
      this.stopped = true;
      this.queue.abandonPending();
      // A disconnected channel says nothing about a broker's outstanding native
      // read. Its shared release signal remains the only permission to close.
      if (!this.queue.isIdle) warn("backup relay disconnected; waiting for the broker to release its active version");
      this.notifyIdle();
    });
  }

  offer(write: BackupWrite): void {
    if (this.stopped) { releaseOrigin(write); return; }
    this.queue.offer(write);
  }

  private send(write: BackupWrite, signal: Int32Array): void {
    try {
      this.port.postMessage({ write, release: signal } satisfies BackupRelayRequest,
        write.kind === "record" ? [write.bytes.buffer as ArrayBuffer] : []);
    } catch (error) {
      // A synchronous structured-clone/transfer failure did not submit a message.
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
      this.warn("backup relay could not submit a saved version", error);
    }
    void this.waitReleased(signal).then(() => {
      this.queue.reap();
      this.notifyIdle();
    });
  }

  private async waitReleased(signal: Int32Array): Promise<void> {
    while (Atomics.load(signal, 0) !== 1) {
      const waiting = asyncAtomics.waitAsync(signal, 0, 0);
      if (waiting.async) await waiting.value;
      // A synchronous 'not-equal' means the broker released before registration.
    }
  }

  private notifyIdle(): void {
    if (!this.queue.isIdle) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  get isIdle(): boolean { return this.queue.isIdle; }

  idle(): Promise<void> {
    if (this.queue.isIdle) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  drain(boundMs: number): boolean { return this.queue.drain(boundMs); }

  /** Give ordinary quit its short drain, retaining any active lease beyond the bound. */
  stop(boundMs = 0): Promise<void> {
    if (boundMs > 0) this.queue.drain(boundMs);
    this.stopped = true;
    this.queue.abandonPending();
    this.notifyIdle();
    return this.idle();
  }
}
