/**
 * The core's view of the app's data shapes.
 *
 * Most of them ARE the shared shapes and are re-exported from `@shared/types`
 * rather than restated here. The file used to declare its own copy of every one,
 * on the stated premise that "the two type worlds can't import each other" —
 * which was never true: `tsconfig.node.json` includes `src/shared/**`, the alias
 * is configured for main, and files in this very directory already import from
 * it. The copies had begun to drift, and nothing could catch them.
 *
 * What remains below is what genuinely differs, and the difference is the point:
 * the core deals in what a `.md` file holds and where it lives, while the shared
 * shapes describe what crosses the IPC boundary — where a "post" may equally be
 * a list summary.
 */

export type {
  AiConfig,
  AiConfigsData,
  AiProvider,
  AnalysisPrompt,
  ContentFont,
  EditablePostMetadata,
  GenerationPromptsData,
  PostIndexEntry,
  PostStatus,
  Settings,
  Target,
  UiState,
  Workspace,
} from "@shared/types";

export { AI_PROVIDERS } from "@shared/types";

import type {
  AiProvider,
  AnalysisPrompt,
  GenerationPromptsData,
  PostIndexEntry,
  PostStatus,
  Settings,
  Target,
  Workspace,
} from "@shared/types";

// --- Post: the on-disk shapes ---

/**
 * Front matter as a post FILE holds it.
 *
 * Distinct from the shared `PostFrontMatter`, which also has to describe a list
 * summary: there, `updatedAtUtc` is optional (the index projection omits it) and
 * `excerpt` exists (the index derives it). On disk neither is true — every post
 * file carries an update time, and no file carries an excerpt.
 *
 * Base fields (title, tags, metaDescription) are always in the post's native
 * language. When the content language is not English, fixed *En variants hold
 * the English supplements; when it is English, only base fields are used.
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

/** A post as the core holds it: the file's contents plus where the file is. */
export interface Post {
  frontMatter: PostFrontMatter;
  content: string; // Markdown body (everything after the front matter)
  filePath: string; // absolute path to the .md file on disk
}

/**
 * A post in a list view. The core answers with the index projection, which is
 * what a list needs and nothing more — the shared `PostSummary` carries the
 * looser boundary front matter instead.
 */
export interface PostSummary {
  frontMatter: PostIndexEntry;
}

// --- Workspace registry ---

export interface AppConfig {
  workspaces: Workspace[];
}

// --- Config file ---

/**
 * The persisted shape of an AI config in the workspace's `config.json` (the
 * `aiConfigs` section). The API key is deliberately absent — it lives in the
 * storage-root secrets file, keyed by (workspace id, config id), so a
 * git-versioned workspace never carries a secret (storage-path conventions). The
 * config id is the link between the committed config and the local key.
 */
export interface StoredAiConfig {
  id: string;
  name: string;
  provider: AiProvider;
  model: string;
  thinking: boolean;
  maxTokens: number;
}

export const CONFIG_SCHEMA_VERSION = 1;

/**
 * The single per-workspace config file (`config.json`): all of a workspace's
 * durable settings, flat (no nested "settings" wrapper), with top-level keys
 * ordered to mirror the Settings modal — general fields, then targets, AI
 * configs, analysis prompts, generation prompts. The active AI config is NOT
 * here; it is volatile session state (services/activeConfig), defaulting to the
 * first config each launch.
 */
export interface WorkspaceConfig extends Settings {
  schemaVersion: number;
  targets: Target[];
  aiConfigs: StoredAiConfig[];
  analysisPrompts: AnalysisPrompt[];
  generationPrompts: GenerationPromptsData;
}
