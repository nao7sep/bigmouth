// Pure navigation helpers shared by every composite control in the app (the
// post listbox, the right-pane and settings tablists, the hamburger menu). They
// own the focus-cursor arithmetic and type-ahead matching so each control's hook
// stays a thin DOM/state shell over these tested functions.
//
// Everything here is side-effect free: no DOM, no React. The composite-control
// conventions split "where is the cursor" (these helpers) from "what is focused
// in the DOM" (the hooks) and "what is committed" (the app's own state).

/** Direction the arrow keys move the active cursor. */
export type NavDirection = -1 | 1;

/**
 * Next index when moving the active cursor by `direction` (-1 up, +1 down)
 * through a list of `length` items, clamped to the ends — stop-at-ends, no
 * wrap (the conventional list/tablist default). `current` is the current index,
 * or -1 when nothing is active yet: then Down lands on the first item and Up on
 * the last, so the first arrow press always enters the control. Returns -1 for
 * an empty list.
 */
export function nextIndex(
  direction: NavDirection,
  current: number,
  length: number,
): number {
  if (length === 0) return -1;
  if (current === -1) return direction === 1 ? 0 : length - 1;
  return Math.min(Math.max(current + direction, 0), length - 1);
}

/** Index of `id` in `ids`, or -1 when absent (or `id` is null/undefined). */
export function indexOfId(ids: readonly string[], id: string | null | undefined): number {
  if (id == null) return -1;
  return ids.indexOf(id);
}

/**
 * Resolves the active cursor index for a control whose cursor and committed
 * selection are separate state. Precedence: the explicit active cursor wins; if
 * none is set, fall back to the currently focused id (a control re-entered by
 * Tab); if neither, fall back to the committed selection; otherwise -1, so the
 * first arrow press enters the control. Only ids actually present in `ids`
 * count — a stale active/selected id that has left the list resolves to -1.
 */
export function currentCompositeIndex({
  ids,
  focusedId,
  activeId,
  selectedId,
}: {
  ids: readonly string[];
  focusedId?: string | null;
  activeId?: string | null;
  selectedId?: string | null;
}): number {
  const fromActive = indexOfId(ids, activeId);
  if (fromActive !== -1) return fromActive;
  const fromFocused = indexOfId(ids, focusedId);
  if (fromFocused !== -1) return fromFocused;
  return indexOfId(ids, selectedId);
}

/**
 * Id that should receive the active cursor after the item `removedId` leaves
 * the list (deleted, archived, status-changed out of view). Computed from the
 * pre-removal `ids` in display order: the next item, else the previous item,
 * else null when it was the only item — the general recovery policy. Returns
 * null when `removedId` is not in the list. Mirrors `pickAdjacentPostId` at the
 * id level so the listbox cursor recovers to the same neighbour the session's
 * selection does.
 */
export function removalFocusTargetId(
  ids: readonly string[],
  removedId: string,
): string | null {
  const index = ids.indexOf(removedId);
  if (index === -1) return null;
  return ids[index + 1] ?? ids[index - 1] ?? null;
}

/**
 * Type-ahead: given the items' labels in display order, the index the cursor is
 * currently on (-1 when none), and the buffered query the user has typed, return
 * the index of the next item whose label starts with the query (case-insensitive),
 * searching forward from just after `current` and wrapping once through the whole
 * list so a match behind the cursor is still found. Returns -1 when nothing
 * matches or the query is empty. Pure — the caller owns the buffer and its idle
 * reset, and guards against IME composition before calling.
 */
export function typeAheadMatch(
  labels: readonly string[],
  current: number,
  query: string,
): number {
  if (query === "") return -1;
  const needle = query.toLowerCase();
  const length = labels.length;
  for (let offset = 1; offset <= length; offset++) {
    const candidate = (current + offset + length) % length;
    if (labels[candidate]?.toLowerCase().startsWith(needle)) return candidate;
  }
  return -1;
}

/** One section of a grouped list: its items, in display order, plus whether it
 * is currently expanded. */
export interface CompositeGroup<T> {
  items: readonly T[];
  open: boolean;
}

/**
 * Flattens a grouped list into the single continuous sequence the arrow keys
 * navigate. A collapsed group contributes nothing (its items are not rendered,
 * so they are not navigable); expanded groups contribute their items in order,
 * and the groups keep their declared order. This is what makes several visual
 * sections behave as one composite control: navigation flows across group
 * boundaries over exactly the currently-rendered options.
 */
export function flatPostListIds<T>(groups: readonly CompositeGroup<T>[]): T[] {
  const flat: T[] = [];
  for (const group of groups) {
    if (!group.open) continue;
    for (const item of group.items) flat.push(item);
  }
  return flat;
}
