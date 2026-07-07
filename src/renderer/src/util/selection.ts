import type { PostSummary } from "@shared/types";

/**
 * Picks the post that should take the selection after the post with `id` is
 * removed from `list` (its section, in display order): the next one, else the
 * previous one, else null when it was the only post. Returns null if `id` is
 * not in the list.
 *
 * Compute this from the pre-removal list, then apply it — so deleting the open
 * post keeps you on its neighbour instead of dropping you to an empty pane.
 */
export function pickAdjacentPostId(list: PostSummary[], id: string): string | null {
  const index = list.findIndex((p) => p.frontMatter.id === id);
  if (index === -1) return null;
  const next = list[index + 1];
  if (next) return next.frontMatter.id;
  const prev = list[index - 1];
  if (prev) return prev.frontMatter.id;
  return null;
}
