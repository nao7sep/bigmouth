/**
 * Built-in prompt templates for metadata field generation.
 *
 * Each template receives the post content via {content}.
 * Templates are keyed by field base name; language-specific variants
 * are built at runtime using the language name.
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
    `Return only the title text with no quotes and no extra explanation.\n\nContent:\n{content}`
  );
}

export function slugPrompt(): string {
  return (
    `Generate a URL-friendly slug in English for the following blog post. ` +
    `Use only lowercase letters, numbers, and hyphens. Maximum 60 characters. ` +
    `Return only the slug with no extra explanation.\n\nContent:\n{content}`
  );
}

export function tagsPrompt(lang: string): string {
  const name = languageName(lang);
  return (
    `Generate 5 to 8 relevant tags in ${name} for the following blog post. ` +
    `Return only a comma-separated list of tags with no extra explanation.\n\nContent:\n{content}`
  );
}

export function metaDescriptionPrompt(lang: string): string {
  const name = languageName(lang);
  return (
    `Write a compelling SEO meta description in ${name} for the following blog post. ` +
    `Keep it between 120 and 160 characters. ` +
    `Return only the description text with no extra explanation.\n\nContent:\n{content}`
  );
}

/**
 * Returns the rendered prompt for a given front matter field key and post content.
 * Returns null if the field is not generatable.
 */
export function promptForField(
  field: string,
  content: string
): string | null {
  let template: string | null = null;

  if (field === "title") {
    template = titlePrompt("en");
  } else if (field === "slug") {
    template = slugPrompt();
  } else if (field === "tags") {
    template = tagsPrompt("en");
  } else if (field === "metaDescription") {
    template = metaDescriptionPrompt("en");
  } else {
    // Language-specific variants: titleJa, tagsEs, metaDescriptionFr, etc.
    const titleMatch = field.match(/^title([A-Z][a-z]+)$/);
    const tagsMatch = field.match(/^tags([A-Z][a-z]+)$/);
    const descMatch = field.match(/^metaDescription([A-Z][a-z]+)$/);

    if (titleMatch) {
      template = titlePrompt(titleMatch[1].toLowerCase());
    } else if (tagsMatch) {
      template = tagsPrompt(tagsMatch[1].toLowerCase());
    } else if (descMatch) {
      template = metaDescriptionPrompt(descMatch[1].toLowerCase());
    }
  }

  if (!template) return null;
  return template.replace("{content}", content);
}
