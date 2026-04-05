/**
 * Filename generation and parsing for post files.
 *
 * Draft:     {createdAtUtc}-{nanoid}.md    e.g., 20260405-143022-utc-V1StGXR8_Z5jdHi6B-myT.md
 * Ready:     {readyAtUtc}-{slug}.md        e.g., 20260405-220000-utc-my-first-post.md
 * Published: same as ready (filename does not change)
 */

import { formatForFilename } from "./timestamps.js";

/**
 * Generates a filename for a draft post.
 */
export function draftFilename(createdAtUtc: Date, nanoid: string): string {
  return `${formatForFilename(createdAtUtc)}-${nanoid}.md`;
}

/**
 * Generates a filename for a ready or published post.
 */
export function readyFilename(readyAtUtc: Date, slug: string): string {
  return `${formatForFilename(readyAtUtc)}-${slug}.md`;
}

/**
 * Determines the correct filename for a post based on its status.
 */
export function postFilename(
  status: "draft" | "ready" | "published",
  createdAtUtc: Date,
  nanoid: string,
  readyAtUtc: Date | undefined,
  slug: string | undefined
): string {
  if (status === "draft") {
    return draftFilename(createdAtUtc, nanoid);
  }

  // Ready or published: requires both readyAtUtc and slug
  if (!readyAtUtc || !slug) {
    throw new Error(
      `Post in "${status}" status requires readyAtUtc and slug for filename`
    );
  }

  return readyFilename(readyAtUtc, slug);
}
