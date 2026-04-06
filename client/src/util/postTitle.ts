import type { PostFrontMatter } from "../types";

/** Returns the best available display title for a post: title → titleEn → slug → id */
export function getPostTitle(fm: PostFrontMatter): string {
  return fm.title || fm.titleEn || fm.slug || fm.id;
}
