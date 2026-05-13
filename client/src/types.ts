// --- Workspace ---

export interface Workspace {
  id: string;
  name: string;
  dataDirectory: string;
}

// --- Post ---

export type PostStatus = "draft" | "ready" | "published";

export interface PostFrontMatter {
  id: string;
  target: string;
  status: PostStatus;
  language: string;
  sourceId?: string;
  title?: string;         // native language
  titleEn?: string;         // English supplement (omitted when language is "en")
  slug?: string;
  tags?: string[];        // native language
  metaDescription?: string; // native language
  tagsEn?: string[];        // English supplement (omitted when language is "en")
  metaDescriptionEn?: string; // English supplement (omitted when language is "en")
  extra?: string;
  createdAtUtc: string;
  updatedAtUtc: string;
  readyAtUtc?: string;
  publishedAtUtc?: string;
  [key: string]: unknown;
}

export interface PostSummary {
  frontMatter: PostFrontMatter;
}

export interface Post {
  frontMatter: PostFrontMatter;
  content: string;
}

export interface PostListResponse {
  drafts: PostSummary[];
  ready: PostSummary[];
  published: PostSummary[];
  publishedTotal: number;
  publishedOffset: number;
}

export interface Target {
  name: string;
  defaultLanguage: string;
  requiresMetadata: boolean;
}

export interface AnalysisPrompt {
  name: string;
  text: string;
}

export interface AssetMeta {
  filename: string;
  size: number;
  width?: number;
  height?: number;
  hasMetadata?: boolean;
  uploadedAt: string;
}

export const AI_PROVIDERS = ["claude"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiConfig {
  id: string;
  name: string;
  provider: AiProvider;
  apiKey: string;
  hasApiKey?: boolean;
  model: string;
}

export interface GenerationPromptsData {
  prompts: Record<string, string>;
}

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

export interface AiConfigsData {
  activeId: string;
  configs: AiConfig[];
}

export interface Settings {
  timezone: string;
  supportedLanguages: string[];
  publishedPostsPerLoad: number;
  maxUploadMb: number;
  editorWatermark: string;
  extraFieldWatermark: string;
}
