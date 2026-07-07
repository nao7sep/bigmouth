// The pure dirty-tracking and save-drain behind the MetadataTab. Dirtiness is
// derived by comparing the current value against a snapshot of what was last
// confirmed saved — there is no separate dirty flag to forget across save paths.
// Both sides are raw strings, so the comparison is exact (no parse round-trip
// that could make a field look perpetually unsaved).

/** A field is dirty when its current value differs from its last-saved value. */
export function isFieldDirty(current: string | undefined, saved: string | undefined): boolean {
  return (current ?? "") !== (saved ?? "");
}

/** The keys (of `current`) whose value differs from the saved snapshot. */
export function dirtyFieldKeys(
  current: Record<string, string>,
  saved: Record<string, string>,
): string[] {
  return Object.keys(current).filter((key) => isFieldDirty(current[key], saved[key]));
}

/**
 * Persist every dirty field, re-checking after each pass until none remain. A
 * field edited *while one of these saves was in flight* still differs from the
 * value that was actually written, so it stays dirty and is picked up on the
 * next pass — an edit is never silently lost to a save race. Each successful
 * persist advances the saved snapshot, so this converges; a failed persist stops
 * the drain and surfaces as `false`. `persist` saves a key's current value and
 * advances its snapshot.
 */
export async function flushDirtyFields(
  getDirtyKeys: () => string[],
  persist: (key: string) => Promise<boolean>,
): Promise<boolean> {
  let ok = true;
  for (let pending = getDirtyKeys(); pending.length > 0; pending = getDirtyKeys()) {
    for (const key of pending) {
      if (!(await persist(key))) ok = false;
    }
    if (!ok) break;
  }
  return ok;
}
