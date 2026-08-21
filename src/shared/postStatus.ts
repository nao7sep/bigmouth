/**
 * The four post states, and the one rule that says which of them are locked.
 *
 * Both processes need this: main enforces the lock at every write, and the
 * renderer decides what to render read-only from the same answer. It used to
 * live in the core, under a comment calling itself "the single source of truth
 * for the lock" — while the renderer re-spelled it twice, once as its own
 * `isLockedStatus` helper and once inlined, because it could not import from
 * there. A fifth status, or a decision to lock `ready`, would have landed in
 * main and left the UI editable.
 */

import type { PostStatus } from "./types.js";

/** The four states, in the order the UI presents them. The one enumeration. */
export const POST_STATUSES: readonly PostStatus[] = ["draft", "ready", "published", "expired"];

/** Whether an arbitrary value — a hand-edited front-matter field, an IPC argument — is a status. */
export function isPostStatus(value: unknown): value is PostStatus {
  return typeof value === "string" && (POST_STATUSES as readonly string[]).includes(value);
}

/**
 * Published and expired posts are locked: their content, metadata and assets are
 * immutable until the post is moved back to Draft or Ready.
 */
export function isEditLocked(status: PostStatus): boolean {
  return status === "published" || status === "expired";
}
