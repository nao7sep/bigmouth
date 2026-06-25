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

export const AI_PROVIDERS = ["claude"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiConfig {
  id: string;
  name: string;
  provider: AiProvider;
  apiKey: string; // empty in responses to the renderer; the stored key never crosses the bridge
  hasApiKey?: boolean; // a key is stored for THIS config (env-independent)
  usingEnvKey?: boolean; // the provider's env var is set, so it overrides any stored key
  model: string;
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

export interface Settings {
  timezone: string;
  supportedLanguages: string[];
  publishedPostsPerLoad: number;
  maxUploadMb: number;
  editorWatermark: string;
  extraFieldWatermark: string;
}
