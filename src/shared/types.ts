// The canonical data shapes exchanged across the IPC boundary between the main
// process and the renderer. The single source
// of truth: the renderer imports these directly, and the core keeps only its
// internal supersets (the on-disk `Post` with `filePath`, `PostIndexEntry`). It
// must stay environment-neutral (no DOM, no Node types), since `src/shared` is
// type-checked under both the node and web configs.

import type { Message } from "./i18n/translate.js";

// --- Workspace ---

export interface Workspace {
  id: string;
  name: string;
  dataDirectory: string;
}

// --- UI state (state.json) ---

import { RECORDS_LIST_WIDTH } from "./layout.js";

// The side-pane INTENT defaults (px) — what a fresh install starts each pane at,
// before the user drags. The single source for both the persisted default
// (defaultUiState) and the renderer's in-memory seed (App.tsx), so the two can't
// drift. The displayed width is derived by clamping the intent to the live
// container (see paneConstants.clampPaneWidth); these are the intents, not the
// display.
export const DEFAULT_PANE_LEFT_WIDTH = 360;
export const DEFAULT_PANE_RIGHT_WIDTH = 480;

/**
 * Ephemeral UI state persisted to `~/.bigmouth/state.json` — saved by the app on
 * the user's behalf, not authored as configuration. It has its own store, apart
 * from the workspace registry (workspaces.json) and each per-workspace config.json,
 * per persisted-store-separation-conventions: a settings reset must not touch it,
 * and its splitter-drag churn must not rewrite a config file. It is disposable:
 * losing it just reopens the picker and restores default
 * pane widths.
 */
export interface UiState {
  paneLeftWidth: number;   // left side-pane INTENT width (px); display is clamped at render time
  paneRightWidth: number;  // right side-pane INTENT width (px)
  activeWorkspaceId: string; // last-selected workspace id; "" = none (open the picker)
  // Electron's zoom LEVEL (not a factor): 0 is 100%, each step is ~1.2x. The View
  // menu's zoom roles mutate webContents in memory only, so without persisting it
  // a user who zoomed for readability was back at 100% every launch, silently.
  zoomLevel: number;
  // The records window's list pane INTENT width (px), clamped when shown.
  recordsListWidth: number;
}

/** A fresh UI state: default pane widths and no remembered workspace. */
export function defaultUiState(): UiState {
  return {
    paneLeftWidth: DEFAULT_PANE_LEFT_WIDTH,
    paneRightWidth: DEFAULT_PANE_RIGHT_WIDTH,
    activeWorkspaceId: "",
    zoomLevel: 0,
    recordsListWidth: RECORDS_LIST_WIDTH.default,
  };
}

// --- App settings (the storage root's config.json) ---

import type { LanguagePreference } from "./i18n/languages.js";

/** The saved appearance choice. System follows the OS appearance. */
export type ThemePreference = "system" | "light" | "dark";

/**
 * The user's app-wide choices, persisted to `~/.bigmouth/config.json` and
 * applied in every workspace. Its own store: each workspace keeps its settings
 * in its own config.json, and view state lives in state.json
 * (persisted-store-separation conventions).
 */
export interface AppSettings {
  theme: ThemePreference;
  // The interface language: "system", which follows the computer's language on
  // every launch, or a tag from @shared/i18n/languages.
  language: LanguagePreference;
}

/** App settings as the renderer reads them, plus what the user is told about
 *  the file this launch could not use (null when there is nothing to tell). */
export interface AppSettingsLoad {
  settings: AppSettings;
  notice: Message | null;
}

// --- Post ---

export type PostStatus = "draft" | "discarded" | "verified" | "published" | "retired";

export interface PostFrontMatter {
  id: string;
  target: string;
  status: PostStatus;
  language: string;
  sourceId?: string;
  title?: string; // native language
  titleEn?: string; // English supplement (omitted when language is "en")
  excerpt?: string; // body-derived preview in list summaries (untitled posts only)
  slug?: string;
  tags?: string[]; // native language
  metaDescription?: string; // native language
  tagsEn?: string[]; // English supplement (omitted when language is "en")
  metaDescriptionEn?: string; // English supplement (omitted when language is "en")
  extra?: string;
  createdAtUtc: string;
  updatedAtUtc?: string; // present on full posts; omitted from list summaries
  discardedAtUtc?: string;
  verifiedAtUtc?: string;
  publishedAtUtc?: string;
  retiredAtUtc?: string;
  locked?: boolean; // content-lifecycle-conventions' locked flag; absent means unlocked
  [key: string]: unknown;
}

/**
 * One row of the derived post index — the canonical list projection the main
 * process sends for a post, and the definition both processes use. Deliberately
 * carries NO updatedAtUtc: the index excludes the one field every content save
 * changes, so a projection must never be read as an edit time.
 * A type alias, not an interface, so it stays assignable where the looser
 * PostFrontMatter (with its index signature) is expected.
 */
export type PostIndexEntry = {
  id: string;
  fileName: string; // basename of the .md file, stable for the post's lifetime
  status: PostStatus;
  target: string;
  language: string;
  slug?: string;
  title?: string;
  titleEn?: string;
  excerpt?: string; // body-derived preview; present only when both titles are absent
  tags?: string[];
  sourceId?: string;
  createdAtUtc: string;
  discardedAtUtc?: string;
  verifiedAtUtc?: string;
  publishedAtUtc?: string;
  retiredAtUtc?: string;
  locked?: true;
};

export interface PostSummary {
  frontMatter: PostFrontMatter;
}

export interface Post {
  frontMatter: PostFrontMatter;
  content: string;
}

/**
 * The result of a post mutation (update / status change): the full post for the
 * editor plus the canonical list summary (the index projection, including the
 * derived excerpt) for the optimistic list update.
 */
export interface PostMutationResult extends Post {
  summary: PostFrontMatter;
}

/**
 * One status's list section: the posts loaded, how many the status holds, and
 * where the loaded page starts. A section that loads whole has `total` equal to
 * its length and `offset` 0.
 */
export interface PostListSection {
  posts: PostSummary[];
  total: number;
  offset: number;
}

/** The Posts list: one section per status. */
export type PostListResponse = Record<PostStatus, PostListSection>;

/**
 * The subset of front matter a client may edit. Identity (id) and lifecycle
 * fields (status, *AtUtc, locked) are intentionally absent — identity never
 * changes, and the lifecycle moves only through the dedicated status and lock
 * operations. A null value clears the field.
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
  name: string;
  defaultLanguage: string;
  requiresMetadata: boolean;
}

// --- Analysis prompt ---

export interface AnalysisPrompt {
  name: string;
  text: string;
}

// --- Asset ---

export interface AssetMeta {
  filename: string;
  size: number;
  width?: number;
  height?: number;
  hasMetadata?: boolean;
  // When the app stored the file. Absent for a file it found in the folder
  // without a record of its upload: that time is unknown, and never guessed.
  uploadedAt?: string;
}

/**
 * A post's attached files. `movedAside` is set when the asset metadata could not
 * be read and was moved to `movedTo`, so the files are listed from the folder.
 */
export interface AssetListing {
  assets: AssetMeta[];
  movedAside?: { path: string; movedTo: string };
}

// --- AI settings ---

import type { AiRole } from "./aiModels.js";

/**
 * A workspace's Anthropic section (ai-model-routing-conventions): the endpoint, a
 * model per role, and each role's thinking value. Each is its own config set.
 */
export interface AnthropicSettings {
  endpoint: string;
  models: Record<AiRole, string>;
  thinking: Record<AiRole, string>;
}

/** The section as the renderer reads it. The stored key never crosses the bridge. */
export interface AnthropicSettingsView extends AnthropicSettings {
  hasApiKey: boolean; // a key is stored for this workspace (env-independent)
  usingEnvKey: boolean; // ANTHROPIC_API_KEY is set, so it overrides any stored key
}

/** What Save sends: an omitted or blank `apiKey` keeps the stored key. */
export interface AnthropicSettingsInput extends AnthropicSettings {
  apiKey?: string;
}

// --- Generation prompts ---

export interface GenerationPromptsData {
  prompts: Record<string, string>;
}

// --- Imaging ---

export type ImagingRelation = "direct" | "domain" | "abstract";
export type ImagingMood = "bright" | "calm" | "neutral" | "intense" | "hopeful";
export type ImagingLiteralness = "literal" | "stylized" | "symbolic";
export type ImagingPeople = "people" | "mixed" | "no-people";
export type ImagingStyle = "photo" | "illustration" | "anime" | "cinematic" | "minimal";

export interface ImagingOptions {
  count: 3 | 5 | 10;
  relation: ImagingRelation;
  emotionalLens: ImagingMood;
  literalness: ImagingLiteralness;
  people: ImagingPeople;
  style: ImagingStyle;
}

// --- Settings ---

// Content font for the markdown editor — the surface the user writes their own
// text in, so it carries the full per-app-chrome-conventions content-font set
// (family, size, line-height, weight, style, decoration, and — being a multi-line
// field — padding) independent of the UI font. `family` blank means "inherit the
// UI font".
export interface ContentFont {
  family: string;
  size: number;
  lineHeight: number;
  padding: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

// Bounds for the editor content font, shared by the IPC validator and the
// Settings UI so a value can never be representable in one place but not the
// other. Family is free text (engine-resolved), so it has no bound.
export const CONTENT_FONT_SIZE_MIN = 8;
export const CONTENT_FONT_SIZE_MAX = 48;
export const CONTENT_LINE_HEIGHT_MIN = 1;
export const CONTENT_LINE_HEIGHT_MAX = 3;
export const CONTENT_PADDING_MIN = 0;
export const CONTENT_PADDING_MAX = 64;

// The one content-font default: the renderer's pre-load placeholder AND what
// DEFAULT_SETTINGS in the main core materializes at first run, which imports it
// from here rather than restating it.
export const DEFAULT_CONTENT_FONT: ContentFont = {
  family: "",
  size: 14,
  lineHeight: 1.6,
  padding: 16,
  bold: false,
  italic: false,
  underline: false,
};

export interface Settings {
  // "system" (SYSTEM_TIME_ZONE in ./timeZone), which follows the computer on
  // every launch, or an IANA zone chosen from the Settings list.
  timezone: string;
  supportedLanguages: string[];
  postsPerLoad: number; // posts per page of each paged list section
  maxUploadMb: number;
  editorWatermark: string;
  extraFieldWatermark: string;
  // UI (chrome) font family. Blank = the built-in default stack (App.css
  // --bm-font-ui). A non-empty value overrides --bm-font-ui at runtime and is
  // handed to CSS verbatim (engine-resolved, graceful fallback). Family only —
  // no UI font-size knob.
  uiFontFamily: string;
  contentFont: ContentFont;
}
