import { describe, it, expect } from "vitest";
import { getPostTitle } from "./postTitle";
import type { PostFrontMatter } from "../types";

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

describe("getPostTitle", () => {
  it("prefers title", () => {
    expect(
      getPostTitle(frontMatter({ title: "T", titleEn: "TE", slug: "s" }))
    ).toBe("T");
  });

  it("falls back to titleEn when title is missing", () => {
    expect(getPostTitle(frontMatter({ titleEn: "TE", slug: "s" }))).toBe("TE");
  });

  it("falls back to slug when titles are missing", () => {
    expect(getPostTitle(frontMatter({ slug: "s" }))).toBe("s");
  });

  it("falls back to id when nothing else is present", () => {
    expect(getPostTitle(frontMatter())).toBe("abc123");
  });

  it("treats empty strings as absent and continues the chain", () => {
    expect(
      getPostTitle(frontMatter({ title: "", titleEn: "", slug: "s" }))
    ).toBe("s");
  });
});
