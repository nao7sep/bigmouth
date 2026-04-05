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

export interface Settings {
  timezone: string;
  itemsPerPage: number;
  port: number;
  editorWatermark: string;
  extraFieldWatermark: string;
  ai: {
    provider: string;
    apiKey: string;
    model: string;
  };
}
