import { describe, it, expect } from "vitest";
import {
  metadataKeys,
  safePostLogContext,
  safeAiConfigLogContext,
  safeGeneratedFieldSummary,
  safePromptListSummary,
  presentString,
} from "@main/core/shared/logSummaries.js";
import type { AiConfig, Post, PostFrontMatter } from "@main/core/shared/types.js";

function frontMatter(overrides: Partial<PostFrontMatter> = {}): PostFrontMatter {
  return {
    id: "abc123",
    target: "blogger",
    status: "draft",
    language: "en",
    createdAtUtc: "2026-04-05T14:30:22Z",
    updatedAtUtc: "2026-04-05T14:30:22Z",
    ...overrides,
  };
}

describe("metadataKeys", () => {
  it("lists only fields with meaningful content", () => {
    const fm = frontMatter({
      title: "Hello",
      slug: "hello",
      tags: ["a", "b"],
      metaDescription: "   ", // whitespace-only -> excluded
    });
    expect(metadataKeys(fm)).toEqual(["title", "slug", "tags"]);
  });

  it("excludes array fields that contain no non-empty string", () => {
    const fm = frontMatter({ tags: ["", "  "] });
    expect(metadataKeys(fm)).toEqual([]);
  });

  it("is empty when no metadata is present", () => {
    expect(metadataKeys(frontMatter())).toEqual([]);
  });
});

describe("safePostLogContext", () => {
  it("summarizes a post without leaking body content", () => {
    const post: Post = {
      frontMatter: frontMatter({ title: "Secret Title", slug: "my-slug" }),
      content: "This body text must never appear in logs.",
      filePath: "/home/user/.bigmouth/workspaces/w1/posts/20260405-143022-utc-abc123.md",
    };
    const ctx = safePostLogContext(post);

    expect(ctx.contentLength).toBe(post.content.length);
    expect(ctx.fileName).toBe("20260405-143022-utc-abc123.md");
    expect(ctx.metadataKeys).toEqual(["title", "slug"]);

    // The raw body and absolute path must not be present anywhere.
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain("This body text");
    expect(serialized).not.toContain("/home/user");
  });
});

describe("safeAiConfigLogContext", () => {
  it("never includes the API key", () => {
    const config: AiConfig = {
      id: "cfg1",
      name: "Claude",
      provider: "anthropic",
      apiKey: "sk-ant-super-secret",
      model: "claude-opus-4-8",
    };
    const ctx = safeAiConfigLogContext(config);
    expect(JSON.stringify(ctx)).not.toContain("sk-ant-super-secret");
    expect(ctx).not.toHaveProperty("apiKey");
  });

  it("falls back to (unnamed) for a blank name", () => {
    const config: AiConfig = {
      id: "cfg1",
      name: "",
      provider: "anthropic",
      apiKey: "",
      model: "claude-opus-4-8",
    };
    expect(safeAiConfigLogContext(config).aiConfigName).toBe("(unnamed)");
  });
});

describe("safeGeneratedFieldSummary", () => {
  it("counts tags split on commas", () => {
    const summary = safeGeneratedFieldSummary({ tags: " a, b ,, c " });
    expect(summary.tags).toEqual({ kind: "tags", count: 3, textLength: 9 });
  });

  it("reports string length and includes slug value", () => {
    const summary = safeGeneratedFieldSummary({ slug: " my-slug " });
    expect(summary.slug).toEqual({ kind: "string", length: 7, slug: "my-slug" });
  });

  it("reports plain string length without echoing other field values", () => {
    const summary = safeGeneratedFieldSummary({ title: "A Long Secret Title" });
    expect(summary.title).toEqual({ kind: "string", length: 19 });
  });
});

describe("safePromptListSummary", () => {
  it("reports count and trimmed lengths", () => {
    expect(safePromptListSummary(["abc", "  de  ", ""])).toEqual({
      count: 3,
      lengths: [3, 2, 0],
    });
  });
});

describe("presentString", () => {
  it("returns the trimmed value when present", () => {
    expect(presentString("  hello  ")).toBe("hello");
  });

  it("returns a dash for undefined or blank", () => {
    expect(presentString(undefined)).toBe("-");
    expect(presentString("   ")).toBe("-");
  });
});
