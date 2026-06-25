// --- Post ---

export type PostStatus = "draft" | "ready" | "published" | "expired";

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
  title?: string; // native language
  titleEn?: string; // English supplement (omitted when language is "en")
  slug?: string; // always English; optional — never required to change status
  tags?: string[]; // native language
  metaDescription?: string; // native language
  tagsEn?: string[]; // English supplement (omitted when language is "en")
  metaDescriptionEn?: string; // English supplement (omitted when language is "en")
  extra?: string; // free-text KVP field
  createdAtUtc: string; // ISO 8601; never changes (encoded in the filename)
  updatedAtUtc: string; // ISO 8601; bumped on every content/metadata edit
  readyAtUtc?: string; // set when status reaches ready; cleared only on return to draft
  publishedAtUtc?: string; // set on first publish; preserved on edit; cleared only on return to draft
  expiredAtUtc?: string; // set when status reaches expired; cleared only on return to draft
  [key: string]: unknown;
}

export interface Post {
  frontMatter: PostFrontMatter;
  content: string; // Markdown body (everything after the front matter)
  filePath: string; // absolute path to the .md file on disk
}

/**
 * One row of the derived post index (posts/index.json). A fixed projection of a
 * post's front matter — the catalog used for list views, id→file resolution,
 * and search. Deliberately excludes updatedAtUtc (the one field that changes on
 * every content save) so a content edit never churns the index, and excludes
 * the body and the *En/metaDescription/extra fields, which the list does not need.
 */
export interface PostIndexEntry {
  id: string;
  fileName: string; // basename of the .md file, stable for the post's lifetime
  status: PostStatus;
  target: string;
  language: string;
  slug?: string;
  title?: string;
  titleEn?: string;
  excerpt?: string; // body-derived preview; present only when title and titleEn are both absent
  tags?: string[];
  sourceId?: string;
  createdAtUtc: string;
  readyAtUtc?: string;
  publishedAtUtc?: string;
  expiredAtUtc?: string;
}

/**
 * Lightweight version of Post for list views — the index projection, no content.
 */
export interface PostSummary {
  frontMatter: PostIndexEntry;
}

/**
 * The subset of front matter the renderer may edit through the update operation.
 * Identity (id) and lifecycle fields (status, createdAtUtc, updatedAtUtc,
 * readyAtUtc, publishedAtUtc, expiredAtUtc) are intentionally absent: identity
 * never changes and lifecycle moves only through the status-change operation. A
 * null value clears the field.
 */
export interface EditablePostMetadata {
  target?: string | null;
  language?: string | null;
  title?: string | null;
  titleEn?: string | null;
  slug?: string | null;
  tags?: string[] | null;
  tagsEn?: string[] | null;
  metaDescription?: string | null;
  metaDescriptionEn?: string | null;
  extra?: string | null;
  sourceId?: string | null;
}

// --- Target ---

export interface Target {
  name: string; // slug-ish display name (e.g., "blogger", "x-company")
  defaultLanguage: string; // two-letter code
  requiresMetadata: boolean;
}

// --- Workspace ---

export interface Workspace {
  id: string;            // nanoid, stable identity
  name: string;          // user-defined label
  dataDirectory: string; // absolute path to the workspace data directory
}

export interface AppConfig {
  workspaces: Workspace[];
}

// --- Settings ---

export const AI_PROVIDERS = ["claude"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiConfig {
  id: string;        // nanoid, stable identity
  name: string;      // user-defined label (e.g., "Claude Sonnet")
  provider: AiProvider;
  apiKey: string;    // obfuscated in settings.json, plain in memory, empty in the renderer-facing view
  hasApiKey?: boolean; // renderer-facing flag: true when a key is stored on disk
  model: string;     // e.g., "claude-sonnet-4-6"
}

export interface Settings {
  timezone: string;                // IANA timezone (e.g., "Asia/Tokyo")
  supportedLanguages: string[];    // ISO 639-1 codes shown in language selects (e.g., ["en", "es", "ja"])
  publishedPostsPerLoad: number;   // batch size for the published posts list (default: 50)
  maxUploadMb: number;             // max asset upload size in MB (default: 500)
  editorWatermark: string;         // placeholder text in the empty editor
  extraFieldWatermark: string;     // placeholder text in the extra textarea
}

export interface AiConfigsData {
  activeId: string;
  configs: AiConfig[];
}

export interface GenerationPromptsData {
  prompts: Record<string, string>;
}

// --- Analysis Prompt ---

export interface AnalysisPrompt {
  name: string; // display label
  text: string; // full prompt text, {content} is replaced with post content
}
