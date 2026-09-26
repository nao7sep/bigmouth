/**
 * Generation prompt field order and labels used by the Settings UI.
 *
 * Prompt text defaults come from the main process, and the key list from
 * @shared/metadataFields — the renderer carries neither. It used to carry a
 * byte-identical copy of the keys, which is the half that could actually drift.
 */

import type { MessageKey } from "@shared/i18n/catalogues";

export { GENERATION_PROMPT_KEYS } from "@shared/metadataFields";

// Each field's name on screen, the same names the Metadata tab shows.
export const GENERATION_PROMPT_LABELS: Record<string, MessageKey> = {
  title: "metadata.title",
  titleEn: "metadata.titleEn",
  slug: "metadata.slug",
  tags: "metadata.tags",
  tagsEn: "metadata.tagsEn",
  metaDescription: "metadata.description",
  metaDescriptionEn: "metadata.descriptionEn",
};
