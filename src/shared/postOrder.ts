/**
 * How a post list is ordered — one definition, used by both processes.
 *
 * The main process sorted from the index and the renderer re-sorted after an
 * optimistic mutation, and the two disagreed on every tie-breaker: main broke
 * ties on `id` descending, the renderer on `slug` descending, and the
 * renderer's draft comparator had no tie-breaker at all. Since the
 * renderer re-inserts a mutated post on every metadata save and every
 * background content save, two posts sharing a timestamp sat in one order until
 * the next `listPosts` and a different one after it — the list visibly
 * reshuffling under the user with no edit.
 *
 * Both sides already hold exactly the fields below, so the comparators take the
 * narrowest shape that orders a post rather than either process's own type.
 */

import type { PostStatus } from "./types.js";

/** A list section's own time: what it is sorted by and what each row shows. */
export type ListTimeKey = "createdAtUtc" | "discardedAtUtc" | "publishedAtUtc" | "retiredAtUtc";

/**
 * Each section's time. Draft and verified posts are ordered by creation; a
 * discarded, published or retired post by the time it entered that status.
 */
export const LIST_TIME_KEY: Readonly<Record<PostStatus, ListTimeKey>> = {
  draft: "createdAtUtc",
  discarded: "discardedAtUtc",
  verified: "createdAtUtc",
  published: "publishedAtUtc",
  retired: "retiredAtUtc",
};

/** What ordering a post needs. Both `PostIndexEntry` and the boundary front matter satisfy it. */
export interface OrderablePost {
  id: string;
  createdAtUtc: string;
  discardedAtUtc?: string;
  publishedAtUtc?: string;
  retiredAtUtc?: string;
}

/**
 * Chronological comparison of two ISO instants. An unparseable value sorts
 * before every real one rather than being treated as equal to them, so a
 * damaged timestamp cannot silently shuffle into the middle of a list.
 */
export function compareInstants(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
  if (Number.isNaN(ta)) return -1;
  if (Number.isNaN(tb)) return 1;
  if (ta < tb) return -1;
  if (ta > tb) return 1;
  return 0;
}

function compareDesc(a: string, b: string): number {
  if (a < b) return 1;
  if (a > b) return -1;
  return 0;
}

/**
 * The tie-breaker for every section: post id, descending.
 *
 * It has to be a field every post carries and no edit changes — `slug` is
 * optional and editable, so ordering by it moved posts around when a slug was
 * filled in, and left every slug-less post tied with every other.
 */
function byIdDesc(a: OrderablePost, b: OrderablePost): number {
  return compareDesc(a.id, b.id);
}

export function byCreatedDesc(a: OrderablePost, b: OrderablePost): number {
  return compareInstants(b.createdAtUtc, a.createdAtUtc) || byIdDesc(a, b);
}

/** Newest first by `key`, then by creation time, then by id. */
function byTimeDesc(key: Exclude<ListTimeKey, "createdAtUtc">) {
  return (a: OrderablePost, b: OrderablePost): number =>
    compareInstants(b[key] ?? "", a[key] ?? "") || byCreatedDesc(a, b);
}

const COMPARATORS: Readonly<Record<ListTimeKey, (a: OrderablePost, b: OrderablePost) => number>> = {
  createdAtUtc: byCreatedDesc,
  discardedAtUtc: byTimeDesc("discardedAtUtc"),
  publishedAtUtc: byTimeDesc("publishedAtUtc"),
  retiredAtUtc: byTimeDesc("retiredAtUtc"),
};

/** The comparator a status's section is sorted by. */
export function comparatorFor(status: PostStatus): (a: OrderablePost, b: OrderablePost) => number {
  return COMPARATORS[LIST_TIME_KEY[status]];
}
