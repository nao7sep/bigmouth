/**
 * Built-in field guidance for structured metadata generation.
 *
 * The app owns the request-level prompt and JSON schema. These strings are
 * configurable field-specific style/content instructions.
 */

export const GENERATION_PROMPT_KEYS = [
  "title",
  "titleEn",
  "slug",
  "tags",
  "tagsEn",
  "metaDescription",
  "metaDescriptionEn",
] as const;

export const DEFAULT_GENERATION_PROMPTS: Record<string, string> = {
  title:
    `Write the title in the same language as the draft.\n` +
    `- Use the draft's central angle, not just its broad topic.\n` +
    `- Keep it concise, plain, and natural.\n` +
    `- Preserve the author's perspective and degree of emotion.\n` +
    `- Do not add a subtitle, decorative framing, clickbait, or claims not in the draft.`,
  titleEn:
    `Write the English title for the draft.\n` +
    `- Match the same central angle as the native title when one exists or is also requested.\n` +
    `- Prefer natural English over literal translation.\n` +
    `- Keep it concise, plain, and natural.\n` +
    `- Do not add extra drama, stronger emotion, clickbait, or claims not in the draft.`,
  slug:
    `Write a short readable English URL slug.\n` +
    `- Derive it from the English title or central angle when available.\n` +
    `- Prefer a natural phrase over a keyword list.\n` +
    `- Use only lowercase letters, numbers, and hyphens.\n` +
    `- Keep it specific, memorable, and under 60 characters.`,
  tags:
    `Write 5 to 8 tags in the same language as the draft.\n` +
    `- Cover the main concrete topics and useful searchable concepts.\n` +
    `- Use short topic labels, not explanatory phrases.\n` +
    `- Keep each tag to one concept.\n` +
    `- Prefer the shortest natural form that still makes sense.`,
  tagsEn:
    `Write 5 to 8 English tags.\n` +
    `- Cover the same core concepts as the native tags when they exist or are also requested.\n` +
    `- Use short searchable topic labels, not explanatory phrases.\n` +
    `- Keep each tag to one concept.\n` +
    `- Prefer natural English terms over literal translation.`,
  metaDescription:
    `Write a meta description in the same language as the draft.\n` +
    `- Align it with the selected title and central angle.\n` +
    `- Summarize what the post actually offers, without adding a new thesis.\n` +
    `- Keep the author's perspective and tone.\n` +
    `- Aim for 120-160 characters.`,
  metaDescriptionEn:
    `Write an English meta description for the draft.\n` +
    `- Align it with the English title and central angle.\n` +
    `- Summarize what the post actually offers, without adding a new thesis.\n` +
    `- Keep the author's perspective and tone.\n` +
    `- Do not add extra drama or stronger emotion.\n` +
    `- Aim for 120-160 characters.`,
};

/**
 * Returns the system prompt for a given field key.
 * Returns null if the field is not a generatable metadata key.
 */
export function systemPromptForField(
  field: string,
  customPrompts: Record<string, string>
): string | null {
  if (!(field in DEFAULT_GENERATION_PROMPTS)) return null;
  return customPrompts[field] ?? DEFAULT_GENERATION_PROMPTS[field];
}
