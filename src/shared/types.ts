// The canonical data shapes exchanged across the IPC boundary between the main
// process and the renderer. The single source
// of truth: the renderer imports these directly, and the core keeps only its
// internal supersets (the on-disk `Post` with `filePath`, `PostIndexEntry`). It
// must stay environment-neutral (no DOM, no Node types), since `src/shared` is
// type-checked under both the node and web configs.

// --- Workspace ---

export interface Workspace {
  id: string;
  name: string;
  dataDirectory: string;
}

// --- UI state (state.json) ---

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
 * and its splitter-drag churn must not rewrite a config file. Machine-/display-
 * specific and disposable — losing it just reopens the picker and restores default
 * pane widths. (Was three keys in renderer localStorage: bm-pane-left-width,
 * bm-pane-right-width, bm-workspace-id.)
 */
export interface UiState {
  paneLeftWidth: number;   // left side-pane INTENT width (px); display is clamped at render time
  paneRightWidth: number;  // right side-pane INTENT width (px)
  activeWorkspaceId: string; // last-selected workspace id; "" = none (open the picker)
  // Electron's zoom LEVEL (not a factor): 0 is 100%, each step is ~1.2x. The View
  // menu's zoom roles mutate webContents in memory only, so without persisting it
  // a user who zoomed for readability was back at 100% every launch, silently.
  zoomLevel: number;
}

/** A fresh UI state: default pane widths and no remembered workspace. */
export function defaultUiState(): UiState {
  return {
    paneLeftWidth: DEFAULT_PANE_LEFT_WIDTH,
    paneRightWidth: DEFAULT_PANE_RIGHT_WIDTH,
    activeWorkspaceId: "",
    zoomLevel: 0,
  };
}

// --- Post ---

export type PostStatus = "draft" | "ready" | "published" | "expired";

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
  readyAtUtc?: string;
  publishedAtUtc?: string;
  expiredAtUtc?: string;
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
  readyAtUtc?: string;
  publishedAtUtc?: string;
  expiredAtUtc?: string;
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

export interface PostListResponse {
  drafts: PostSummary[];
  ready: PostSummary[];
  published: PostSummary[];
  publishedTotal: number;
  publishedOffset: number;
  expired: PostSummary[];
  expiredTotal: number;
  expiredOffset: number;
}

/**
 * The subset of front matter a client may edit. Identity (id) and lifecycle
 * fields (status, *AtUtc) are intentionally absent — identity never changes and
 * lifecycle moves only through the dedicated status-change operation. A null value
 * clears the field.
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
  uploadedAt: string;
}

// --- AI config ---

// The model list and its derivations live in ./modelRegistry — re-exported here
// because every consumer already reaches for "@shared/types" and the split is an
// organizing choice, not a change of surface.
export {
  DEFAULT_MODEL_ID,
  MODEL_DEFS,
  defaultMaxTokens,
  findModelDef,
  resolveThinking,
  validateMaxTokens,
  type ModelDef,
} from "./modelRegistry.js";

export const AI_PROVIDERS = ["anthropic"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

// User-facing display names. The internal id is the conventional vendor/env name
// (api-key-storage-conventions); the product label is a display mapping only.
export const PROVIDER_LABELS: Record<AiProvider, string> = { anthropic: "Claude" };

export interface AiConfig {
  id: string;
  name: string;
  provider: AiProvider;
  apiKey: string; // empty in responses to the renderer; the stored key never crosses the bridge
  hasApiKey?: boolean; // a key is stored for THIS config (env-independent)
  usingEnvKey?: boolean; // the provider's env var is set, so it overrides any stored key
  model: string; // an id from MODEL_DEFS
  thinking: boolean; // adaptive thinking; always false on a model that rejects it
  maxTokens: number; // within maxTokensRange() of the selected model
}

export interface AiConfigsData {
  activeId: string;
  configs: AiConfig[];
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
  timezone: string;
  supportedLanguages: string[];
  publishedPostsPerLoad: number;
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
