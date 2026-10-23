import type { BackupWrite } from "./backupWorker.js";

interface Entry { write: BackupWrite; bytes: number; descriptors: number; onRelease?: () => void }

/** One in flight; replace only pending versions, preserving the order of their latest saves. */
export class BackupAdmission {
  private pending = new Map<string, Entry>();
  private active: (Entry & { signal: Int32Array }) | null = null;
  private bytes = 0;
  private descriptors = 0;
  private unavailable = false;

  constructor(
    private readonly limits: { bytes: number; descriptors: number },
    private readonly send: (write: BackupWrite, signal: Int32Array) => void,
    private readonly release: (write: BackupWrite) => void,
    private readonly overflow: () => void,
  ) {}

  /** The caller owns its bytes; copy only once admission succeeds. File descriptors are consumed. */
  offer(write: BackupWrite, onRelease?: () => void): void {
    let retained = false;
    try {
      this.reap();
      const key = JSON.stringify([write.file, write.path]);
      const previous = this.pending.get(key);
      if (previous) { this.pending.delete(key); this.discard(previous); }
      // Include path/metadata and entry overhead: tiny writes cannot create an unbounded map.
      const bytes = 1024 + 2 * (write.path.length + write.file.length) + (write.kind === "record" ? write.bytes.byteLength : 0);
      const descriptors = write.kind === "record-file" ? 1 : 0;
      if (this.bytes + bytes > this.limits.bytes || this.descriptors + descriptors > this.limits.descriptors) {
        if (!this.unavailable) { this.unavailable = true; this.overflow(); }
        return;
      }
      const owned = write.kind === "record" ? { ...write, bytes: new Uint8Array(write.bytes) } : write;
      this.bytes += bytes;
      this.descriptors += descriptors;
      this.pending.set(key, { write: owned, bytes, descriptors, onRelease });
      retained = true;
      this.dispatch();
    } finally {
      if (!retained) {
        if (onRelease) onRelease();
        else this.release(write);
      }
    }
  }

  private discard(entry: Entry): void {
    this.bytes -= entry.bytes;
    this.descriptors -= entry.descriptors;
    if (entry.onRelease) entry.onRelease();
    else this.release(entry.write);
  }

  /** No submitted or pending version still owns bytes or a descriptor. */
  get isIdle(): boolean { return this.active === null && this.pending.size === 0; }

  /** Shared completion works even while the origin is synchronously draining at shutdown. */
  reap(): void {
    if (this.active && Atomics.load(this.active.signal, 0) === 1) {
      this.discard(this.active);
      this.active = null;
      if (this.pending.size === 0) this.unavailable = false;
    }
    this.dispatch();
  }

  private dispatch(): void {
    if (this.active) return;
    const first = this.pending.entries().next().value;
    if (!first) return;
    const [key, entry] = first;
    this.pending.delete(key);
    this.active = { ...entry, signal: new Int32Array(new SharedArrayBuffer(4)) };
    this.send(entry.write, this.active.signal);
  }

  drain(boundMs: number): boolean {
    const deadline = performance.now() + boundMs;
    this.reap();
    while (this.active) {
      const remaining = deadline - performance.now();
      if (remaining <= 0 || Atomics.wait(this.active.signal, 0, 0, remaining) === "timed-out") return false;
      this.reap();
    }
    return true;
  }

  /** Drop unissued work now. Keep the active descriptor until the worker physically exits. */
  abandonPending(): void {
    for (const entry of this.pending.values()) this.discard(entry);
    this.pending.clear();
  }

  retired(): void {
    this.abandonPending();
    if (this.active) { this.discard(this.active); this.active = null; }
  }
}
