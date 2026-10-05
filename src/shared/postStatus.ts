/**
 * The post statuses, in the order content-lifecycle-conventions gives them, and
 * which of them the Posts list pages.
 *
 * Both processes need this: main lists and validates by it, and the renderer
 * renders the status radios and the list sections from the same enumeration.
 * Whether a post can be edited is not a status question: it is the post's own
 * `locked` flag.
 */

import type { PostStatus } from "./types.js";
import type { MessageKey } from "./i18n/catalogues.js";

/** The five statuses, in the order the UI presents them. The one enumeration. */
export const POST_STATUSES: readonly PostStatus[] = ["draft", "discarded", "verified", "published", "retired"];

/** Each status's name on screen; the stored value stays the English word. */
export const POST_STATUS_LABELS: Readonly<Record<PostStatus, MessageKey>> = {
  draft: "status.draft",
  discarded: "status.discarded",
  verified: "status.verified",
  published: "status.published",
  retired: "status.retired",
};

/** The statuses whose list sections load a page at a time; the others load whole. */
export type PagedPostStatus = "discarded" | "published" | "retired";

export const PAGED_POST_STATUSES: readonly PagedPostStatus[] = ["discarded", "published", "retired"];

/** Where each paged section's first page starts. */
export const FIRST_PAGES: Readonly<Record<PagedPostStatus, number>> = { discarded: 0, published: 0, retired: 0 };

export function isPagedPostStatus(status: PostStatus): status is PagedPostStatus {
  return (PAGED_POST_STATUSES as readonly PostStatus[]).includes(status);
}

/**
 * Whether a post in `status` holds a publication time: only published and
 * retired do, so moving to any other status clears it (the transition table in
 * content-lifecycle-conventions).
 */
export function holdsPublicationTime(status: PostStatus): boolean {
  return status === "published" || status === "retired";
}

/** Whether an arbitrary value — a hand-edited front-matter field, an IPC argument — is a status. */
export function isPostStatus(value: unknown): value is PostStatus {
  return typeof value === "string" && (POST_STATUSES as readonly string[]).includes(value);
}
