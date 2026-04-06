// --- Post ---

export type PostStatus = "draft" | "ready" | "published";

/**
 * Front matter fields stored in each post's Markdown file.
 * Base fields (title, tags, metaDescription) are always in the post's native language.
 * When the content language is not English, fixed *En variants (titleEn, tagsEn,
 * metaDescriptionEn) hold the English supplements.
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
  title?: string; // native language
  slug?: string; // always English, required for ready status
  tags?: string[]; // native language
  metaDescription?: string; // native language
  titleEn?: string; // English supplement (omitted when language is "en")
  tagsEn?: string[]; // English supplement (omitted when language is "en")
  metaDescriptionEn?: string; // English supplement (omitted when language is "en")
  extra?: string; // free-text KVP field
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

export const AI_PROVIDERS = ["claude"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiConfig {
  id: string;        // nanoid, stable identity
  name: string;      // user-defined label (e.g., "Claude Sonnet")
  provider: AiProvider;
  apiKey: string;    // obfuscated in settings.json, plain in memory
  model: string;     // e.g., "claude-sonnet-4-6"
}

export interface Settings {
  port: number;                    // local server port (default: 3141)
  timezone: string;                // IANA timezone (e.g., "Asia/Tokyo")
  supportedLanguages: string[];    // ISO 639-1 codes shown in language selects (e.g., ["en", "ja"])
  publishedPostsPerLoad: number;   // batch size for the published posts list (default: 50)
  editorWatermark: string;         // placeholder text in the empty editor
  extraFieldWatermark: string;     // placeholder text in the extra textarea
  aiConfigs: AiConfig[];
  activeAiConfigId: string;
}

// --- Prompt ---

export interface Prompt {
  name: string; // display label
  text: string; // full prompt text, {content} is replaced with post content
}
