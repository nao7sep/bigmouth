/**
 * Post lifecycle state machine.
 *
 * The three states form a strict order: draft < checked < published.
 *
 * Two lifecycle timestamps track how far a post has advanced:
 *   - checkedAtUtc   — the post has been reviewed ("checked")
 *   - publishedAtUtc — the post has been published (public, treated carefully)
 *
 * Both follow one rule: set-if-absent when moving forward, and cleared only
 * when the post drops back to `draft`. Consequences:
 *
 *   draft     → checked   : checkedAt set (if absent)
 *   checked   → draft     : checkedAt cleared
 *   draft     → published : checkedAt + publishedAt set (if absent)
 *   checked   → published : publishedAt set if absent (first publish); kept otherwise
 *   published → checked   : both kept — the in-place edit / typo-fix lane
 *   published → draft     : both cleared — the rewrite-and-repost lane
 *
 * Because re-publishing only sets publishedAt when it is absent, the round trip
 * published → checked → published (used to fix a typo) preserves the original
 * publication time. Only a deliberate return to draft discards it.
 */

import type { PostStatus, PostFrontMatter } from "./types.js";
import { formatUtcIso } from "./timestamps.js";

export const STATUS_ORDER: Record<PostStatus, number> = {
  draft: 0,
  checked: 1,
  published: 2,
};

/**
 * Mutates `fm` to reflect a transition to `newStatus`, applying the lifecycle
 * timestamp rules above. Pure with respect to I/O. Does not validate the
 * transition (e.g. the slug requirement) — that is the store's responsibility.
 */
export function applyStatusTransition(
  fm: PostFrontMatter,
  newStatus: PostStatus,
  now: Date
): void {
  const stamp = formatUtcIso(now);

  if (newStatus === "draft") {
    fm.checkedAtUtc = undefined;
    fm.publishedAtUtc = undefined;
  } else if (newStatus === "checked") {
    if (!fm.checkedAtUtc) fm.checkedAtUtc = stamp;
    // publishedAt is left untouched, so it survives published → checked.
  } else if (newStatus === "published") {
    if (!fm.checkedAtUtc) fm.checkedAtUtc = stamp;
    if (!fm.publishedAtUtc) fm.publishedAtUtc = stamp;
  }

  fm.status = newStatus;
}
