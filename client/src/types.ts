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
  createdAtUtc: string;
  updatedAtUtc: string;
  readyAtUtc?: string;
  publishedAtUtc?: string;
  title?: string;         // native language
  slug?: string;
  tags?: string[];        // native language
  metaDescription?: string; // native language
  titleEn?: string;         // English supplement (omitted when language is "en")
  tagsEn?: string[];        // English supplement (omitted when language is "en")
  metaDescriptionEn?: string; // English supplement (omitted when language is "en")
  extra?: string;
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
  model: string;
}

export interface GenerationPromptsData {
  preamble: string;
  prompts: Record<string, string>;
}

export interface AiConfigsData {
  configs: AiConfig[];
  activeId: string;
}

export interface Settings {
  timezone: string;
  supportedLanguages: string[];
  publishedPostsPerLoad: number;
  maxUploadMb: number;
  editorWatermark: string;
  extraFieldWatermark: string;
}
