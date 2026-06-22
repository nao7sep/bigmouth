import { describe, it, expect } from "vitest";
import { applyPostMutationToBuckets, type PostBuckets } from "../../src/util/postBuckets";
import type { PostStatus, PostSummary } from "../../src/types";

function summary(
  id: string,
  status: PostStatus,
  extra: Partial<PostSummary["frontMatter"]> = {}
): PostSummary {
  return {
    frontMatter: {
      id,
      target: "blog",
      status,
      language: "en",
      createdAtUtc: "2026-01-01T00:00:00.000Z",
      ...extra,
    },
  };
}

function buckets(overrides: Partial<PostBuckets> = {}): PostBuckets {
  return {
    drafts: [],
    ready: [],
    published: [],
    publishedTotal: 0,
    expired: [],
    expiredTotal: 0,
    ...overrides,
  };
}

const ids = (list: PostSummary[]) => list.map((p) => p.frontMatter.id);

describe("applyPostMutationToBuckets", () => {
  it("moves a post draft -> ready without touching totals", () => {
    const prev = buckets({ drafts: [summary("a", "draft")] });
    const next = applyPostMutationToBuckets(prev, summary("a", "ready"), "ready", null);
    expect(ids(next.drafts)).toEqual([]);
    expect(ids(next.ready)).toEqual(["a"]);
    expect(next.publishedTotal).toBe(0);
    expect(next.expiredTotal).toBe(0);
  });

  it("moves ready -> published and increments publishedTotal", () => {
    const prev = buckets({ ready: [summary("a", "ready")] });
    const next = applyPostMutationToBuckets(
      prev,
      summary("a", "published", { publishedAtUtc: "2026-02-01T00:00:00.000Z" }),
      "published",
      null
    );
    expect(ids(next.ready)).toEqual([]);
    expect(ids(next.published)).toEqual(["a"]);
    expect(next.publishedTotal).toBe(1);
    expect(next.expiredTotal).toBe(0);
  });

  it("moves published -> expired, shifting one off publishedTotal onto expiredTotal", () => {
    const prev = buckets({
      published: [summary("a", "published", { publishedAtUtc: "2026-02-01T00:00:00.000Z" })],
      publishedTotal: 1,
    });
    const next = applyPostMutationToBuckets(
      prev,
      summary("a", "expired", {
        publishedAtUtc: "2026-02-01T00:00:00.000Z",
        expiredAtUtc: "2026-03-01T00:00:00.000Z",
      }),
      "expired",
      null
    );
    expect(ids(next.published)).toEqual([]);
    expect(ids(next.expired)).toEqual(["a"]);
    expect(next.publishedTotal).toBe(0);
    expect(next.expiredTotal).toBe(1);
  });

  it("moves expired -> published, shifting one off expiredTotal onto publishedTotal", () => {
    const prev = buckets({
      expired: [summary("a", "expired", { expiredAtUtc: "2026-03-01T00:00:00.000Z" })],
      expiredTotal: 1,
    });
    const next = applyPostMutationToBuckets(
      prev,
      summary("a", "published", { publishedAtUtc: "2026-02-01T00:00:00.000Z" }),
      "published",
      null
    );
    expect(ids(next.expired)).toEqual([]);
    expect(ids(next.published)).toEqual(["a"]);
    expect(next.expiredTotal).toBe(0);
    expect(next.publishedTotal).toBe(1);
  });

  it("moves expired -> draft and decrements only expiredTotal", () => {
    const prev = buckets({
      expired: [summary("a", "expired", { expiredAtUtc: "2026-03-01T00:00:00.000Z" })],
      expiredTotal: 1,
    });
    const next = applyPostMutationToBuckets(prev, summary("a", "draft"), "draft", null);
    expect(ids(next.drafts)).toEqual(["a"]);
    expect(ids(next.expired)).toEqual([]);
    expect(next.expiredTotal).toBe(0);
    expect(next.publishedTotal).toBe(0);
  });

  it("updates a published post in place without duplicating it or changing the total", () => {
    const prev = buckets({
      published: [summary("a", "published", { publishedAtUtc: "2026-02-01T00:00:00.000Z" })],
      publishedTotal: 1,
    });
    const next = applyPostMutationToBuckets(
      prev,
      summary("a", "published", { publishedAtUtc: "2026-02-01T00:00:00.000Z", title: "edited" }),
      "published",
      null
    );
    expect(ids(next.published)).toEqual(["a"]);
    expect(next.published[0].frontMatter.title).toBe("edited");
    expect(next.publishedTotal).toBe(1);
  });

  it("does not fold a re-saved published post that is off the loaded page back onto the page", () => {
    // previousStatus comes from openPostStatus="published"; the post is not in
    // the loaded published list, so it must not be hoisted onto the page, and the
    // total must stay put (it was already published, still published).
    const prev = buckets({
      published: [summary("onpage", "published", { publishedAtUtc: "2026-09-01T00:00:00.000Z" })],
      publishedTotal: 5,
    });
    const next = applyPostMutationToBuckets(
      prev,
      summary("deep", "published", { publishedAtUtc: "2026-01-01T00:00:00.000Z", title: "edited" }),
      "published",
      "published"
    );
    expect(ids(next.published)).toEqual(["onpage"]);
    expect(next.publishedTotal).toBe(5);
  });

  it("does not fold a re-saved expired post that is off the loaded page back onto the page", () => {
    const prev = buckets({
      expired: [summary("onpage", "expired", { expiredAtUtc: "2026-09-01T00:00:00.000Z" })],
      expiredTotal: 5,
    });
    const next = applyPostMutationToBuckets(
      prev,
      summary("deep", "expired", { expiredAtUtc: "2026-01-01T00:00:00.000Z" }),
      "expired",
      "expired"
    );
    expect(ids(next.expired)).toEqual(["onpage"]);
    expect(next.expiredTotal).toBe(5);
  });

  it("decrements the archive total for an off-page post leaving that archive", () => {
    // A published post reached via a source link (not on the loaded page) moved
    // back to ready: the total must still drop by one even though no visible
    // row is removed.
    const prev = buckets({ publishedTotal: 3 });
    const next = applyPostMutationToBuckets(prev, summary("deep", "ready"), "ready", "published");
    expect(ids(next.ready)).toEqual(["deep"]);
    expect(next.publishedTotal).toBe(2);
  });

  it("never drives a total below zero", () => {
    const prev = buckets({
      published: [summary("a", "published", { publishedAtUtc: "2026-02-01T00:00:00.000Z" })],
      publishedTotal: 0,
    });
    const next = applyPostMutationToBuckets(prev, summary("a", "draft"), "draft", null);
    expect(next.publishedTotal).toBe(0);
  });

  it("inserts into the expired archive in newest-expired-first order", () => {
    const prev = buckets({
      drafts: [summary("new", "draft")],
      expired: [summary("old", "expired", { expiredAtUtc: "2026-01-01T00:00:00.000Z" })],
      expiredTotal: 1,
    });
    const next = applyPostMutationToBuckets(
      prev,
      summary("new", "expired", { expiredAtUtc: "2026-05-01T00:00:00.000Z" }),
      "expired",
      null
    );
    expect(ids(next.drafts)).toEqual([]);
    expect(ids(next.expired)).toEqual(["new", "old"]);
    expect(next.expiredTotal).toBe(2);
  });
});
