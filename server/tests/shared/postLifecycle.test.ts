import { describe, it, expect } from "vitest";
import { applyStatusTransition, STATUS_ORDER } from "../../src/../src/shared/postLifecycle.js";
import type { PostFrontMatter, PostStatus } from "../../src/../src/shared/types.js";

const NOW = new Date("2026-04-05T14:30:22Z");
const STAMP = "2026-04-05T14:30:22Z";

function fm(overrides: Partial<PostFrontMatter> = {}): PostFrontMatter {
  return {
    id: "abc123",
    target: "blogger",
    status: "draft",
    language: "en",
    slug: "my-post",
    createdAtUtc: "2026-01-01T00:00:00Z",
    updatedAtUtc: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function transition(from: Partial<PostFrontMatter>, to: PostStatus): PostFrontMatter {
  const post = fm(from);
  applyStatusTransition(post, to, NOW);
  return post;
}

describe("STATUS_ORDER", () => {
  it("orders draft < checked < published", () => {
    expect(STATUS_ORDER.draft).toBeLessThan(STATUS_ORDER.checked);
    expect(STATUS_ORDER.checked).toBeLessThan(STATUS_ORDER.published);
  });
});

describe("applyStatusTransition", () => {
  it("draft -> checked sets checkedAt only", () => {
    const post = transition({ status: "draft" }, "checked");
    expect(post.status).toBe("checked");
    expect(post.checkedAtUtc).toBe(STAMP);
    expect(post.publishedAtUtc).toBeUndefined();
  });

  it("checked -> draft clears checkedAt", () => {
    const post = transition({ status: "checked", checkedAtUtc: STAMP }, "draft");
    expect(post.checkedAtUtc).toBeUndefined();
  });

  it("draft -> published sets both timestamps", () => {
    const post = transition({ status: "draft" }, "published");
    expect(post.checkedAtUtc).toBe(STAMP);
    expect(post.publishedAtUtc).toBe(STAMP);
  });

  it("checked -> published preserves an existing checkedAt and sets publishedAt", () => {
    const earlier = "2026-02-02T00:00:00Z";
    const post = transition({ status: "checked", checkedAtUtc: earlier }, "published");
    expect(post.checkedAtUtc).toBe(earlier);
    expect(post.publishedAtUtc).toBe(STAMP);
  });

  it("published -> checked keeps both timestamps", () => {
    const pub = "2026-02-02T00:00:00Z";
    const chk = "2026-02-01T00:00:00Z";
    const post = transition(
      { status: "published", checkedAtUtc: chk, publishedAtUtc: pub },
      "checked"
    );
    expect(post.status).toBe("checked");
    expect(post.checkedAtUtc).toBe(chk);
    expect(post.publishedAtUtc).toBe(pub);
  });

  it("published -> draft clears both timestamps", () => {
    const post = transition(
      { status: "published", checkedAtUtc: STAMP, publishedAtUtc: STAMP },
      "draft"
    );
    expect(post.checkedAtUtc).toBeUndefined();
    expect(post.publishedAtUtc).toBeUndefined();
  });

  it("re-publishing preserves an existing publishedAt (set-if-absent)", () => {
    const original = "2026-02-02T00:00:00Z";
    const post = transition(
      { status: "checked", checkedAtUtc: original, publishedAtUtc: original },
      "published"
    );
    expect(post.publishedAtUtc).toBe(original);
  });
});
