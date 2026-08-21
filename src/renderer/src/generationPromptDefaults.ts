/**
 * Generation prompt field order and labels used by the Settings UI.
 *
 * Prompt text defaults come from the main process, and the key list from
 * @shared/metadataFields — the renderer carries neither. It used to carry a
 * byte-identical copy of the keys, which is the half that could actually drift.
 */

export { GENERATION_PROMPT_KEYS } from "@shared/metadataFields";

export const GENERATION_PROMPT_LABELS: Record<string, string> = {
  title: "Title",
  titleEn: "Title (English)",
  slug: "Slug",
  tags: "Tags",
  tagsEn: "Tags (English)",
  metaDescription: "Description",
  metaDescriptionEn: "Description (English)",
};
