import type { BackupWrite } from "./backupWorker.js";

/**
 * One write in flight to the recorder; a newer save of a path replaces its
 * pending version, which keeps the order of the latest saves. A slow recorder
 * therefore holds at most one pending version per protected path.
 */
export class BackupAdmission {
  private pending = new Map<string, BackupWrite>();
  // Sent and not yet applied, in send order; the recorder answers each in turn.
  private inFlight: BackupWrite[] = [];

  constructor(
    private readonly send: (write: BackupWrite) => void,
    private readonly release: (write: BackupWrite) => void,
  ) {}

  /** The caller keeps its bytes; a queued copy is taken. A file descriptor is consumed. */
  offer(write: BackupWrite): void {
    const key = JSON.stringify([write.file, write.path]);
    const previous = this.pending.get(key);
    if (previous) { this.pending.delete(key); this.release(previous); }
    this.pending.set(key, write.kind === "record" ? { ...write, bytes: new Uint8Array(write.bytes) } : write);
    this.dispatch();
  }

  /** The recorder applied the oldest write it was sent; its descriptor is closed on this thread, which opened it. */
  settled(): void {
    const write = this.inFlight.shift();
    if (write) this.release(write);
    this.dispatch();
  }

  /** Hands every pending write to the recorder in save order, for a final drain. */
  flush(): void {
    for (const write of this.pending.values()) this.transmit(write);
    this.pending.clear();
  }

  /** Drops the writes not yet handed to the recorder. */
  abandonPending(): void {
    for (const write of this.pending.values()) this.release(write);
    this.pending.clear();
  }

  private dispatch(): void {
    if (this.inFlight.length > 0) return;
    const first = this.pending.entries().next().value;
    if (!first) return;
    this.pending.delete(first[0]);
    this.transmit(first[1]);
  }

  private transmit(write: BackupWrite): void {
    this.inFlight.push(write);
    this.send(write);
  }
}
