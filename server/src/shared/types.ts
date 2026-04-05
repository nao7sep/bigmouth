// --- Post ---

export type PostStatus = "draft" | "ready" | "published";

/**
 * Front matter fields stored in each post's Markdown file.
 * Base metadata fields (title, tags, metaDescription, slug) are always English.
 * Language-specific variants use a suffix: titleJa, tagsJa, etc.
 * When the content language is English, only base fields are used.
 */
export interface PostFrontMatter {
  id: string; // nanoid, stable identity, never changes
  target: string; // target display name (e.g., "note-personal", "blogger")
  status: PostStatus;
  language: string; // two-letter code: "en", "ja", "es", etc.
  sourceId?: string; // nanoid of another post this derives from
  createdAtUtc: string; // ISO 8601
  updatedAtUtc: string; // ISO 8601
  readyAtUtc?: string; // set when status becomes ready, cleared on revert
  publishedAtUtc?: string; // set when status becomes published, cleared on revert
  title?: string; // always English (fallback)
  slug?: string; // always English, required for ready status
  tags?: string[]; // always English (fallback)
  metaDescription?: string; // always English (fallback)
  extra?: string; // free-text KVP field
  // Language-specific variants are stored as dynamic keys:
  // titleJa, tagsJa, metaDescriptionJa, titleEs, etc.
  [key: string]: unknown;
}

export interface Post {
  frontMatter: PostFrontMatter;
  content: string; // Markdown body (everything after the front matter)
  filePath: string; // absolute path to the .md file on disk
}

/**
 * Lightweight version of Post for list views — front matter only, no content.
 */
export interface PostSummary {
  frontMatter: PostFrontMatter;
}

// --- Target ---

export interface Target {
  name: string; // slug-ish display name (e.g., "blogger", "x-company")
  defaultLanguage: string; // two-letter code
  requiresMetadata: boolean;
}

// --- Settings ---

export interface Settings {
  timezone: string; // IANA timezone (e.g., "Asia/Tokyo")
  itemsPerPage: number; // batch size for post lists (default: 50)
  port: number; // local server port (default: 3141)
  editorWatermark: string; // placeholder text in the empty editor
  extraFieldWatermark: string; // placeholder text in the extra textarea
  ai: AiSettings;
}

export interface AiSettings {
  provider: string; // "claude" for now
  apiKey: string; // obfuscated in settings.json, plain in memory
  model: string; // e.g., "claude-sonnet-4-6"
}

// --- Prompt ---

export interface Prompt {
  name: string; // display label
  text: string; // full prompt text, {content} is replaced with post content
}
