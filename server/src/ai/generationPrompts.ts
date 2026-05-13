/**
 * Built-in system prompt instructions for metadata field generation.
 *
 * Each field prompt is self-contained. Prompts can inline the draft with
 * {content}; tag prompts can also request structured output with {json}.
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
    `Generate a concise title in the same language as the draft.\n` +
    `- Stay close to what the draft actually says.\n` +
    `- Keep the author's perspective.\n` +
    `- Write one plain title.\n` +
    `- Do not split it into multiple parts.\n` +
    `- Do not add a subtitle or decorative framing.\n` +
    `- Return only the title.\n\n` +
    `<content>\n` +
    `{content}\n` +
    `</content>`,
  titleEn:
    `Generate a concise English title for the draft.\n` +
    `- Stay close to what the draft actually says.\n` +
    `- Keep the author's perspective.\n` +
    `- Do not add extra drama or stronger emotion.\n` +
    `- Write one plain title.\n` +
    `- Do not split it into multiple parts.\n` +
    `- Do not add a subtitle or decorative framing.\n` +
    `- Return only the title.\n\n` +
    `<content>\n` +
    `{content}\n` +
    `</content>`,
  slug:
    `Generate a short readable English slug for the draft.\n` +
    `- Prefer a natural phrase, not a keyword list.\n` +
    `- Use only lowercase letters, numbers, and hyphens.\n` +
    `- Maximum 60 characters.\n` +
    `- Return only the slug.\n\n` +
    `<content>\n` +
    `{content}\n` +
    `</content>`,
  tags:
    `Generate 5 to 8 tags in the same language as the draft.\n` +
    `- Focus on the main concrete topics.\n` +
    `- Return short hashtag-style topic labels.\n` +
    `- Prefer the shortest natural form that still makes sense.\n` +
    `- Use searchable topic words, not explanatory phrases.\n` +
    `- Keep each tag to one concept.\n` +
    `- Return JSON only.\n` +
    `- Do not wrap the JSON in markdown fences.\n` +
    `- Do not add any text before or after the JSON.\n` +
    `- Use this exact shape:\n` +
    `{json}\n\n` +
    `<content>\n` +
    `{content}\n` +
    `</content>`,
  tagsEn:
    `Generate 5 to 8 tags in English.\n` +
    `- Focus on the main concrete topics.\n` +
    `- Return short hashtag-style topic labels.\n` +
    `- Prefer the shortest natural form that still makes sense.\n` +
    `- Use searchable topic words, not explanatory phrases.\n` +
    `- Keep each tag to one concept.\n` +
    `- Return JSON only.\n` +
    `- Do not wrap the JSON in markdown fences.\n` +
    `- Do not add any text before or after the JSON.\n` +
    `- Use this exact shape:\n` +
    `{json}\n\n` +
    `<content>\n` +
    `{content}\n` +
    `</content>`,
  metaDescription:
    `Write a meta description in the same language as the draft.\n` +
    `- Length: 120-160 characters.\n` +
    `- Stay close to what the draft actually says.\n` +
    `- Keep the author's perspective.\n` +
    `- Return only the description.\n\n` +
    `<content>\n` +
    `{content}\n` +
    `</content>`,
  metaDescriptionEn:
    `Write an English meta description for the draft.\n` +
    `- Length: 120-160 characters.\n` +
    `- Stay close to what the draft actually says.\n` +
    `- Keep the author's perspective.\n` +
    `- Do not add extra drama or stronger emotion.\n` +
    `- Return only the description.\n\n` +
    `<content>\n` +
    `{content}\n` +
    `</content>`,
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
