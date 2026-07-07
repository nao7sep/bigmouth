/**
 * Post filename generation.
 *
 * Every post lives in a single `posts/` directory under a name that is fixed
 * for the post's entire lifetime:
 *
 *   posts/{createdAtUtc}-{nanoid}.md   e.g. 20260405-143022-utc-V1StGXR8_Z5jD.md
 *
 * The name is computed once at creation and never recomputed, so a status
 * change, slug change, or content edit never moves or renames the file — the
 * change shows up as an in-place diff. The timestamp prefix keeps the directory
 * (and git diffs) in creation order; the nanoid guarantees uniqueness.
 */

import { formatForFilename } from "./timestamps.js";

export function postFileName(createdAtUtc: Date, id: string): string {
  return `${formatForFilename(createdAtUtc)}-${id}.md`;
}
