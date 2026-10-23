// The queue owns snapshots until storage settles them. Account for their data
// and a nonzero packet cost before cloning, including packets with no payload.
const REQUEST_BYTES = 128;
const OBJECT_BYTES = 32;
const MEMBER_BYTES = 16;

function* members(value: object): Generator<unknown> {
  if (Array.isArray(value) || value instanceof Set) {
    yield* value;
  } else if (value instanceof Map) {
    for (const [key, item] of value) { yield key; yield item; }
  } else {
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      yield key;
      yield (value as Record<string, unknown>)[key];
    }
  }
}

/** Measures without cloning or serializing, stopping once admission cannot succeed. */
function snapshotBytes(args: unknown[], available: number): number {
  let bytes = REQUEST_BYTES;
  const seen = new WeakSet<object>();
  // Iterators keep traversal memory proportional to nesting, not array length.
  const pending: Iterator<unknown>[] = [[args].values()];
  while (pending.length && bytes <= available) {
    const next = pending[pending.length - 1].next();
    if (next.done) { pending.pop(); continue; }
    const value = next.value;
    bytes += MEMBER_BYTES;
    if (typeof value === "string") bytes += value.length * 2;
    else if (value === null || typeof value !== "object") bytes += 8;
    else if (!seen.has(value)) {
      seen.add(value);
      bytes += OBJECT_BYTES;
      if (value instanceof Date) bytes += 8;
      // Cloning a view retains its entire backing allocation, even when the
      // view is a tiny slice (including pooled Node Buffers). Count a backing
      // buffer once when several views or a direct reference share it.
      else if (ArrayBuffer.isView(value)) pending.push([value.buffer].values());
      else if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) bytes += value.byteLength;
      else pending.push(members(value));
    }
  }
  return bytes;
}

/** Bounded ownership of queued snapshots; the owner supplies its runtime budget. */
export class StorageAdmission {
  private reservations = new Map<number, number>();
  private used = 0;

  constructor(private readonly limitBytes: number) {}

  reserve(id: number, args: unknown[]): boolean {
    return this.replace(id, id, args);
  }

  release(id: number): void {
    this.used -= this.reservations.get(id) ?? 0;
    this.reservations.delete(id);
  }

  /** A refused replacement leaves the previous snapshot's reservation intact. */
  replace(oldId: number, newId: number, args: unknown[]): boolean {
    const available = this.limitBytes - this.used + (this.reservations.get(oldId) ?? 0);
    const bytes = snapshotBytes(args, available);
    if (bytes > available) return false;
    this.release(oldId);
    this.reservations.set(newId, bytes);
    this.used += bytes;
    return true;
  }

  clear(): void {
    this.reservations.clear();
    this.used = 0;
  }
}
