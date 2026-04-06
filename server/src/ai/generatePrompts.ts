/**
 * Built-in system prompt instructions for metadata field generation.
 *
 * These are pure instructions with no content embedded. The post content is
 * passed separately as the user message so providers can route them correctly.
 */

const LANG_NAMES: Record<string, string> = {
  en: "English",
  ja: "Japanese",
  es: "Spanish",
  fr: "French",
  de: "German",
  ko: "Korean",
  zh: "Chinese",
  pt: "Portuguese",
  it: "Italian",
  ru: "Russian",
};

export function languageName(code: string): string {
  return LANG_NAMES[code] ?? code.toUpperCase();
}

export function titlePrompt(lang: string): string {
  const name = languageName(lang);
  return (
    `Generate a concise, engaging blog post title in ${name} for the following content. ` +
    `Return only the title text with no quotes and no extra explanation.`
  );
}

export function slugPrompt(): string {
  return (
    `Generate a URL-friendly slug in English for the following blog post. ` +
    `Use only lowercase letters, numbers, and hyphens. Maximum 60 characters. ` +
    `Return only the slug with no extra explanation.`
  );
}

export function tagsPrompt(lang: string): string {
  const name = languageName(lang);
  return (
    `Generate 5 to 8 relevant tags in ${name} for the following blog post. ` +
    `Return only a comma-separated list of tags with no extra explanation.`
  );
}

export function metaDescriptionPrompt(lang: string): string {
  const name = languageName(lang);
  return (
    `Write a compelling SEO meta description in ${name} for the following blog post. ` +
    `Keep it between 120 and 160 characters. ` +
    `Return only the description text with no extra explanation.`
  );
}

/**
 * Returns the system prompt instruction for a given front matter field key.
 * Returns null if the field is not generatable.
 * The post content is passed separately as the user message — not embedded here.
 *
 * Base fields (title, tags, metaDescription) are in the post's native language.
 * *En variants (titleEn, tagsEn, metaDescriptionEn) are always English.
 */
export function systemPromptForField(field: string, lang: string): string | null {
  if (field === "title") return titlePrompt(lang);
  if (field === "titleEn") return titlePrompt("en");
  if (field === "slug") return slugPrompt();
  if (field === "tags") return tagsPrompt(lang);
  if (field === "tagsEn") return tagsPrompt("en");
  if (field === "metaDescription") return metaDescriptionPrompt(lang);
  if (field === "metaDescriptionEn") return metaDescriptionPrompt("en");
  return null;
}
