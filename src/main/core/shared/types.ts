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

import type { AnthropicSetKey } from "@shared/configSets";
import type {
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
  updatedAtUtc: string; // ISO 8601; the last content edit (content-lifecycle-conventions' Modified)
  // Status times, set and cleared by the transition table in postLifecycle.ts.
  discardedAtUtc?: string;
  verifiedAtUtc?: string;
  publishedAtUtc?: string;
  retiredAtUtc?: string;
  locked?: boolean; // written only as true; absent means unlocked
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
 * The single per-workspace config file (`config.json`): all of a workspace's
 * durable settings, flat (no nested "settings" wrapper), with top-level keys
 * ordered to mirror the Settings modal — general fields, then targets, the
 * Anthropic section, analysis prompts, generation prompts. The API key is not
 * here: it lives in the storage root's secrets file, keyed by workspace and
 * provider, so a git-versioned workspace never carries a secret.
 */
export interface WorkspaceConfig extends Settings, Record<AnthropicSetKey, string> {
  targets: Target[];
  analysisPrompts: AnalysisPrompt[];
  generationPrompts: GenerationPromptsData;
}
