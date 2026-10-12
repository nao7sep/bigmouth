import type { PostFrontMatter } from "@shared/types";

/**
 * Returns the best available display label for a post:
 * title → titleEn → body excerpt → slug → id. The excerpt is only present in
 * list summaries of untitled posts, so a real post body beats a bare id.
 */
export function getPostTitle(fm: PostFrontMatter): string {
  if (fm.title || fm.titleEn) return fm.title || fm.titleEn!;
  // A cut excerpt carries one marker; where CSS truncates further it clips this
  // one away and draws its own, so a label never shows two.
  if (fm.excerpt) return fm.excerptCut === true ? `${fm.excerpt}…` : fm.excerpt;
  return fm.slug || fm.id;
}
