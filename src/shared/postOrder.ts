/**
 * How a post list is ordered — one definition, used by both processes.
 *
 * The main process sorted from the index and the renderer re-sorted after an
 * optimistic mutation, and the two disagreed on every tie-breaker: main broke
 * ties on `id` descending, the renderer on `slug` descending, and the
 * renderer's draft/ready comparator had no tie-breaker at all. Since the
 * renderer re-inserts a mutated post on every metadata save and every
 * background content save, two posts sharing a timestamp sat in one order until
 * the next `listPosts` and a different one after it — the list visibly
 * reshuffling under the user with no edit.
 *
 * Both sides already hold exactly the fields below, so the comparators take the
 * narrowest shape that orders a post rather than either process's own type.
 */

import type { PostStatus } from "./types.js";

/** What ordering a post needs. Both `PostIndexEntry` and the boundary front matter satisfy it. */
export interface OrderablePost {
  id: string;
  createdAtUtc: string;
  publishedAtUtc?: string;
  expiredAtUtc?: string;
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
 * The tie-breaker for every bucket: post id, descending.
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

export function byPublishedDesc(a: OrderablePost, b: OrderablePost): number {
  return (
    compareInstants(b.publishedAtUtc ?? "", a.publishedAtUtc ?? "") ||
    compareInstants(b.createdAtUtc, a.createdAtUtc) ||
    byIdDesc(a, b)
  );
}

export function byExpiredDesc(a: OrderablePost, b: OrderablePost): number {
  return (
    compareInstants(b.expiredAtUtc ?? "", a.expiredAtUtc ?? "") ||
    compareInstants(b.createdAtUtc, a.createdAtUtc) ||
    byIdDesc(a, b)
  );
}

/** The comparator a bucket is sorted by. */
export function comparatorFor(status: PostStatus): (a: OrderablePost, b: OrderablePost) => number {
  if (status === "published") return byPublishedDesc;
  if (status === "expired") return byExpiredDesc;
  return byCreatedDesc;
}
