/**
 * Filename generation for post files.
 *
 * Draft:     posts/drafts/{createdAtUtc}-{nanoid}.md
 * Ready:     posts/ready/{readyAtUtc}-{slug}.md
 * Published: posts/published/{publishedAtUtc}-{slug}.md
 */

import { formatForFilename } from "./timestamps.js";

export function draftFilename(createdAtUtc: Date, nanoid: string): string {
  return `${formatForFilename(createdAtUtc)}-${nanoid}.md`;
}

export function readyFilename(readyAtUtc: Date, slug: string): string {
  return `${formatForFilename(readyAtUtc)}-${slug}.md`;
}

export function publishedFilename(
  publishedAtUtc: Date,
  slug: string
): string {
  return `${formatForFilename(publishedAtUtc)}-${slug}.md`;
}

/**
 * Returns the subdirectory name for a given status.
 */
export function statusSubdir(
  status: "draft" | "ready" | "published"
): string {
  if (status === "draft") return "drafts";
  if (status === "ready") return "ready";
  return "published";
}
