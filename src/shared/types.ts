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
}

/** A fresh UI state: default pane widths and no remembered workspace. */
export function defaultUiState(): UiState {
  return {
    paneLeftWidth: DEFAULT_PANE_LEFT_WIDTH,
    paneRightWidth: DEFAULT_PANE_RIGHT_WIDTH,
    activeWorkspaceId: "",
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

export const AI_PROVIDERS = ["anthropic"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

// User-facing display names. The internal id is the conventional vendor/env name
// (api-key-storage-conventions); the product label is a display mapping only.
export const PROVIDER_LABELS: Record<AiProvider, string> = { anthropic: "Claude" };

/**
 * A model bigmouth supports, with the capabilities that shape its request. The set
 * is app-owned and closed: the user picks a row and never edits it, so an app update
 * delivers a newer lineup on its own and there is nothing to reset — the
 * config-seeding-conventions case of "an app-owned model list whose parameters are
 * coupled to the model".
 *
 * The list is deliberately NOT a mirror of the provider's catalogue: it claims only
 * what these four models do. `maxOutput` and `supportsAdaptiveThinking` were verified
 * against the live API at design time; the app itself never queries a provider list
 * and lets a bad request fail fast.
 */
export interface ModelDef {
  id: string;
  label: string;
  /**
   * The model's own output ceiling, used only to derive a sane starting budget. The
   * app does NOT police it: a budget the model won't accept is the API's judgment,
   * surfaced at call time (config-seeding's validity boundary).
   */
  maxOutput: number;
  /**
   * Adaptive thinking is the only thinking mode current models accept. Haiku rejects
   * it outright (400 "adaptive thinking is not supported on this model"), so a request
   * for it must never be built.
   */
  supportsAdaptiveThinking: boolean;
}

/** Ordered most- to least-capable. */
export const MODEL_DEFS: readonly ModelDef[] = [
  { id: "claude-opus-4-8", label: "Opus 4.8", maxOutput: 128_000, supportsAdaptiveThinking: true },
  { id: "claude-sonnet-5", label: "Sonnet 5", maxOutput: 128_000, supportsAdaptiveThinking: true },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", maxOutput: 128_000, supportsAdaptiveThinking: true },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", maxOutput: 64_000, supportsAdaptiveThinking: false },
];

export const DEFAULT_MODEL_ID = "claude-sonnet-5";

export function findModelDef(id: string): ModelDef | undefined {
  return MODEL_DEFS.find((m) => m.id === id);
}

/** A model's starting output budget: a tenth of what it can produce. */
export function defaultMaxTokens(model: ModelDef): number {
  return Math.floor(model.maxOutput / 10);
}

/**
 * Why a budget is unusable, or null when it is fine. This checks only that the number
 * is a sane one to send — whether the model will accept it is not ours to decide, and
 * a rejected value surfaces as the API's own error at call time.
 */
export function validateMaxTokens(maxTokens: number): string | null {
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    return "Max tokens must be a whole number of 1 or more.";
  }
  return null;
}

/** Adaptive thinking is only ever on for a model that accepts it. */
export function resolveThinking(model: ModelDef, requested: boolean): boolean {
  return model.supportsAdaptiveThinking && requested;
}

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

// The renderer's pre-load placeholder for the content font. Mirrors
// DEFAULT_SETTINGS.contentFont in the main core (the two type worlds can't import
// each other); keep them in sync.
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
