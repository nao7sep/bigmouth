import { describe, it, expect } from "vitest";
import {
  applyStatusTransition,
  isEditLocked,
  isPostStatus,
  POST_STATUSES,
} from "@main/core/shared/postLifecycle.js";
import type { PostFrontMatter, PostStatus } from "@main/core/shared/types.js";

const NOW = new Date("2026-04-05T14:30:22Z");
const STAMP = "2026-04-05T14:30:22.000Z";

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

describe("isEditLocked", () => {
  it("locks published and expired, leaves draft and ready editable", () => {
    expect(isEditLocked("draft")).toBe(false);
    expect(isEditLocked("ready")).toBe(false);
    expect(isEditLocked("published")).toBe(true);
    expect(isEditLocked("expired")).toBe(true);
  });
});

describe("POST_STATUSES", () => {
  it("is the one enumeration of the four states, and recognizes nothing else", () => {
    // The list is what this app enumerates. Its ordering is presentation-only;
    // the transition function accepts every recognized status from every state.
    expect(POST_STATUSES).toEqual(["draft", "ready", "published", "expired"]);
    expect(isPostStatus("published")).toBe(true);
    // A hand-edited front matter can carry anything at all.
    expect(isPostStatus("Draft")).toBe(false);
    expect(isPostStatus("archived")).toBe(false);
    expect(isPostStatus(undefined)).toBe(false);
  });
});

describe("applyStatusTransition", () => {
  it("draft -> ready sets readyAt only", () => {
    const post = transition({ status: "draft" }, "ready");
    expect(post.status).toBe("ready");
    expect(post.readyAtUtc).toBe(STAMP);
    expect(post.publishedAtUtc).toBeUndefined();
  });

  it("ready -> draft clears readyAt", () => {
    const post = transition({ status: "ready", readyAtUtc: STAMP }, "draft");
    expect(post.readyAtUtc).toBeUndefined();
  });

  it("draft -> published sets both timestamps", () => {
    const post = transition({ status: "draft" }, "published");
    expect(post.readyAtUtc).toBe(STAMP);
    expect(post.publishedAtUtc).toBe(STAMP);
  });

  it("ready -> published preserves an existing readyAt and sets publishedAt", () => {
    const earlier = "2026-02-02T00:00:00Z";
    const post = transition({ status: "ready", readyAtUtc: earlier }, "published");
    expect(post.readyAtUtc).toBe(earlier);
    expect(post.publishedAtUtc).toBe(STAMP);
  });

  it("published -> ready keeps both timestamps", () => {
    const pub = "2026-02-02T00:00:00Z";
    const chk = "2026-02-01T00:00:00Z";
    const post = transition(
      { status: "published", readyAtUtc: chk, publishedAtUtc: pub },
      "ready"
    );
    expect(post.status).toBe("ready");
    expect(post.readyAtUtc).toBe(chk);
    expect(post.publishedAtUtc).toBe(pub);
  });

  it("published -> draft clears both timestamps", () => {
    const post = transition(
      { status: "published", readyAtUtc: STAMP, publishedAtUtc: STAMP },
      "draft"
    );
    expect(post.readyAtUtc).toBeUndefined();
    expect(post.publishedAtUtc).toBeUndefined();
  });

  it("re-publishing preserves an existing publishedAt (set-if-absent)", () => {
    const original = "2026-02-02T00:00:00Z";
    const post = transition(
      { status: "ready", readyAtUtc: original, publishedAtUtc: original },
      "published"
    );
    expect(post.publishedAtUtc).toBe(original);
  });

  it("published -> expired keeps readyAt/publishedAt and sets expiredAt", () => {
    const chk = "2026-02-01T00:00:00Z";
    const pub = "2026-02-02T00:00:00Z";
    const post = transition(
      { status: "published", readyAtUtc: chk, publishedAtUtc: pub },
      "expired"
    );
    expect(post.status).toBe("expired");
    expect(post.readyAtUtc).toBe(chk);
    expect(post.publishedAtUtc).toBe(pub);
    expect(post.expiredAtUtc).toBe(STAMP);
  });

  it("draft -> expired backfills all three timestamps", () => {
    const post = transition({ status: "draft" }, "expired");
    expect(post.readyAtUtc).toBe(STAMP);
    expect(post.publishedAtUtc).toBe(STAMP);
    expect(post.expiredAtUtc).toBe(STAMP);
  });

  it("expired -> published preserves an existing expiredAt (set-if-absent)", () => {
    const exp = "2026-03-03T00:00:00Z";
    const post = transition(
      { status: "expired", readyAtUtc: exp, publishedAtUtc: exp, expiredAtUtc: exp },
      "published"
    );
    expect(post.status).toBe("published");
    expect(post.expiredAtUtc).toBe(exp);
  });

  it("expired -> draft clears all three timestamps", () => {
    const post = transition(
      { status: "expired", readyAtUtc: STAMP, publishedAtUtc: STAMP, expiredAtUtc: STAMP },
      "draft"
    );
    expect(post.readyAtUtc).toBeUndefined();
    expect(post.publishedAtUtc).toBeUndefined();
    expect(post.expiredAtUtc).toBeUndefined();
  });
});
