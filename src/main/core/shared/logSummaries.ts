import path from "node:path";
import type { AiConfig, Post, PostFrontMatter } from "./types.js";

const METADATA_KEYS = [
  "title",
  "titleEn",
  "slug",
  "tags",
  "tagsEn",
  "metaDescription",
  "metaDescriptionEn",
  "extra",
] as const;

export function safePostLogContext(post: Post): Record<string, unknown> {
  const fm = post.frontMatter;
  return {
    postId: fm.id,
    status: fm.status,
    target: fm.target,
    language: fm.language,
    slug: presentString(fm.slug),
    metadataKeys: metadataKeys(fm),
    contentLength: post.content.length,
    fileName: path.basename(post.filePath),
    readyAtUtc: presentString(fm.readyAtUtc),
    publishedAtUtc: presentString(fm.publishedAtUtc),
    expiredAtUtc: presentString(fm.expiredAtUtc),
  };
}

export function safeAiConfigLogContext(config: AiConfig): Record<string, unknown> {
  return {
    aiConfigId: config.id,
    aiConfigName: config.name || "(unnamed)",
    aiProvider: config.provider,
    aiModel: config.model,
  };
}

export function metadataKeys(frontMatter: PostFrontMatter): string[] {
  const keys: string[] = [];
  for (const key of METADATA_KEYS) {
    const value = frontMatter[key];
    if (Array.isArray(value)) {
      if (value.some((item) => typeof item === "string" && item.trim())) keys.push(key);
      continue;
    }
    if (typeof value === "string" && value.trim()) keys.push(key);
  }
  return keys;
}

export function safeGeneratedFieldSummary(
  values: Record<string, string>
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(values)) {
    const trimmed = value.trim();
    if (field === "tags" || field === "tagsEn") {
      const tags = trimmed
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      summary[field] = {
        kind: "tags",
        count: tags.length,
        textLength: trimmed.length,
      };
      continue;
    }
    summary[field] = {
      kind: "string",
      length: trimmed.length,
      ...(field === "slug" ? { slug: trimmed } : {}),
    };
  }
  return summary;
}

export function safePromptListSummary(items: string[]): Record<string, unknown> {
  return {
    count: items.length,
    lengths: items.map((item) => item.trim().length),
  };
}

export function presentString(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "-";
}
