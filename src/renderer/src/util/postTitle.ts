import type { PostFrontMatter } from "@shared/types";

/**
 * Returns the best available display label for a post:
 * title → titleEn → body excerpt → slug → id. The excerpt is only present in
 * list summaries of untitled posts, so a real post body beats a bare id.
 */
export function getPostTitle(fm: PostFrontMatter): string {
  return fm.title || fm.titleEn || fm.excerpt || fm.slug || fm.id;
}
