/**
 * Post lifecycle state machine.
 *
 * The four states are unordered: any state can move directly to any other, and
 * `published → ready` (the in-place typo fix) and `published → draft` (the
 * rewrite-and-repost lane) are ordinary moves, not exceptions. Only the
 * timestamps below are monotone.
 *
 * Three lifecycle timestamps track how far a post has advanced:
 *   - readyAtUtc   — the post has been reviewed ("ready")
 *   - publishedAtUtc — the post has been published (public, treated carefully)
 *   - expiredAtUtc   — the post has been retired ("expired")
 *
 * All follow one rule: set-if-absent when moving forward, and cleared only
 * when the post drops back to `draft`. Consequences:
 *
 *   draft     → ready     : readyAt set (if absent)
 *   ready     → draft     : readyAt cleared
 *   draft     → published : readyAt + publishedAt set (if absent)
 *   ready     → published : publishedAt set if absent (first publish); kept otherwise
 *   published → ready     : both kept — the in-place edit / typo-fix lane
 *   published → draft     : both cleared — the rewrite-and-repost lane
 *   published → expired   : readyAt + publishedAt kept; expiredAt set
 *   expired   → published : readyAt + publishedAt kept; expiredAt kept (set-if-absent)
 *   expired   → draft     : all three cleared
 *
 * Because each forward move only sets a timestamp when it is absent, round
 * trips through a higher state and back (e.g. published → ready → published,
 * or expired → published → expired) preserve the original times. Only a
 * deliberate return to draft discards them.
 */

import type { PostStatus, PostFrontMatter } from "./types.js";
import { formatUtcIso } from "./timestamps.js";

/** The four states, in the order the UI presents them. The one enumeration. */
export const POST_STATUSES: readonly PostStatus[] = ["draft", "ready", "published", "expired"];

/** Whether an arbitrary value — a hand-edited front-matter field, an IPC argument — is a status. */
export function isPostStatus(value: unknown): value is PostStatus {
  return typeof value === "string" && (POST_STATUSES as readonly string[]).includes(value);
}

/**
 * Published and expired posts are locked: their content, metadata, and assets
 * are immutable until the post is moved back to Draft or Ready. This is the
 * single source of truth for the lock, shared by the post-update and asset IPC
 * handlers so they can never diverge on which states are editable.
 */
export function isEditLocked(status: PostStatus): boolean {
  return status === "published" || status === "expired";
}

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
    fm.readyAtUtc = undefined;
    fm.publishedAtUtc = undefined;
    fm.expiredAtUtc = undefined;
  } else if (newStatus === "ready") {
    if (!fm.readyAtUtc) fm.readyAtUtc = stamp;
    // publishedAt / expiredAt are left untouched, so they survive a move back to ready.
  } else if (newStatus === "published") {
    if (!fm.readyAtUtc) fm.readyAtUtc = stamp;
    if (!fm.publishedAtUtc) fm.publishedAtUtc = stamp;
    // expiredAt is left untouched, so it survives expired → published.
  } else if (newStatus === "expired") {
    if (!fm.readyAtUtc) fm.readyAtUtc = stamp;
    if (!fm.publishedAtUtc) fm.publishedAtUtc = stamp;
    if (!fm.expiredAtUtc) fm.expiredAtUtc = stamp;
  }

  fm.status = newStatus;
}
