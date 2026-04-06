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
  title?: string;
  slug?: string;
  tags?: string[];
  metaDescription?: string;
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

export interface Prompt {
  name: string;
  text: string;
}

export interface AssetMeta {
  filename: string;
  size: number;
  width?: number;
  height?: number;
  takenAt?: string;
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

export interface Settings {
  port: number;
  timezone: string;
  publishedPostsPerLoad: number;
  editorWatermark: string;
  extraFieldWatermark: string;
  aiConfigs: AiConfig[];
  activeAiConfigId: string;
}
