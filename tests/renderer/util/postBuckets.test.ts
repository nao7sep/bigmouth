import { describe, it, expect } from "vitest";
import {
  applyPostMutationToLists,
  emptyPostLists,
  listsFromResponse,
  removePostFromLists,
  type PostLists,
} from "@renderer/util/postBuckets";
import type { PostListResponse, PostStatus, PostSummary } from "@shared/types";
import { LIST_TIME_KEY } from "@shared/postOrder";

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

/** A post in `status`, with that section's own time set to `at`. */
function inSection(id: string, status: PostStatus, at = "2026-02-01T00:00:00.000Z", extra = {}): PostSummary {
  return summary(id, status, { [LIST_TIME_KEY[status]]: at, ...extra });
}

function lists(sections: Partial<Record<PostStatus, { posts: PostSummary[]; total?: number }>> = {}): PostLists {
  const next = emptyPostLists();
  for (const [status, section] of Object.entries(sections) as [PostStatus, { posts: PostSummary[]; total?: number }][]) {
    next[status] = { posts: section.posts, total: section.total ?? section.posts.length };
  }
  return next;
}

const ids = (list: PostSummary[]) => list.map((p) => p.frontMatter.id);
const totals = (next: PostLists) =>
  Object.fromEntries(Object.entries(next).map(([status, section]) => [status, section.total]));

const PAGED = ["discarded", "published", "retired"] as const;

describe("applyPostMutationToLists", () => {
  it("moves a post draft -> verified, keeping each whole section's total its length", () => {
    const prev = lists({ draft: { posts: [summary("a", "draft")] } });
    const next = applyPostMutationToLists(prev, summary("a", "verified"), "verified", null);
    expect(ids(next.draft.posts)).toEqual([]);
    expect(ids(next.verified.posts)).toEqual(["a"]);
    expect(totals(next)).toEqual({ draft: 0, discarded: 0, verified: 1, published: 0, retired: 0 });
  });

  it.each(PAGED)("moves verified -> %s and counts it into that section's total", (status) => {
    const prev = lists({ verified: { posts: [summary("a", "verified")] } });
    const next = applyPostMutationToLists(prev, inSection("a", status), status, null);
    expect(ids(next.verified.posts)).toEqual([]);
    expect(ids(next[status].posts)).toEqual(["a"]);
    expect(next[status].total).toBe(1);
  });

  it.each(PAGED.flatMap((from) => PAGED.filter((to) => to !== from).map((to) => [from, to] as const)))(
    "moves %s -> %s, shifting one total onto the other",
    (from, to) => {
      const prev = lists({
        [from]: { posts: [inSection("a", from)], total: 4 },
        [to]: { posts: [inSection("b", to, "2026-01-01T00:00:00.000Z")], total: 2 },
      });
      const next = applyPostMutationToLists(prev, inSection("a", to), to, null);
      expect(ids(next[from].posts)).toEqual([]);
      expect(ids(next[to].posts)).toEqual(["a", "b"]);
      expect(next[from].total).toBe(3);
      expect(next[to].total).toBe(3);
    },
  );

  it.each(PAGED)("updates a %s post in place without duplicating it or changing the total", (status) => {
    const prev = lists({ [status]: { posts: [inSection("a", status)], total: 1 } });
    const next = applyPostMutationToLists(prev, inSection("a", status, undefined, { title: "edited" }), status, null);
    expect(ids(next[status].posts)).toEqual(["a"]);
    expect(next[status].posts[0].frontMatter.title).toBe("edited");
    expect(next[status].total).toBe(1);
  });

  it.each(PAGED)("does not fold a re-saved %s post that is off the loaded page back onto the page", (status) => {
    // The previous status comes from the open post; the post is not on the
    // loaded page, so it must not be hoisted onto it, and the total stays put.
    const prev = lists({ [status]: { posts: [inSection("onpage", status, "2026-09-01T00:00:00.000Z")], total: 5 } });
    const next = applyPostMutationToLists(prev, inSection("deep", status, "2026-01-01T00:00:00.000Z"), status, status);
    expect(ids(next[status].posts)).toEqual(["onpage"]);
    expect(next[status].total).toBe(5);
  });

  it("keeps a restored old publication off the loaded published rows while older rows are unloaded", () => {
    // 4 published posts, the newest 2 loaded. Retired -> published keeps the
    // publication time, which belongs below the loaded rows: adding it would
    // make the next page start past a row nobody loaded, and fetch this one again.
    const prev = lists({
      published: {
        posts: [
          inSection("p4", "published", "2026-04-01T00:00:00.000Z"),
          inSection("p3", "published", "2026-03-01T00:00:00.000Z"),
        ],
        total: 4,
      },
      retired: { posts: [inSection("old", "retired", "2026-09-01T00:00:00.000Z")], total: 1 },
    });
    const restored = summary("old", "published", { publishedAtUtc: "2026-01-15T00:00:00.000Z" });
    const next = applyPostMutationToLists(prev, restored, "published", null);
    expect(ids(next.published.posts)).toEqual(["p4", "p3"]);
    expect(next.published.total).toBe(5);
    expect(ids(next.retired.posts)).toEqual([]);
    expect(next.retired.total).toBe(0);
  });

  it("adds a restored publication that sorts among the loaded published rows", () => {
    const prev = lists({
      published: {
        posts: [
          inSection("p4", "published", "2026-04-01T00:00:00.000Z"),
          inSection("p2", "published", "2026-02-01T00:00:00.000Z"),
        ],
        total: 4,
      },
      retired: { posts: [inSection("mid", "retired", "2026-09-01T00:00:00.000Z")], total: 1 },
    });
    const restored = summary("mid", "published", { publishedAtUtc: "2026-03-01T00:00:00.000Z" });
    const next = applyPostMutationToLists(prev, restored, "published", null);
    expect(ids(next.published.posts)).toEqual(["p4", "mid", "p2"]);
    expect(next.published.total).toBe(5);
  });

  it.each(PAGED)("decrements the %s total for an off-page post leaving it", (status) => {
    // Reached via a source link (not on the loaded page) and moved to draft:
    // the total still drops by one though no visible row is removed.
    const prev = lists({ [status]: { posts: [], total: 3 } });
    const next = applyPostMutationToLists(prev, summary("deep", "draft"), "draft", status);
    expect(ids(next.draft.posts)).toEqual(["deep"]);
    expect(next[status].total).toBe(2);
  });

  it("never drives a total below zero", () => {
    const prev = lists({ published: { posts: [inSection("a", "published")], total: 0 } });
    const next = applyPostMutationToLists(prev, summary("a", "draft"), "draft", null);
    expect(next.published.total).toBe(0);
  });

  it.each(PAGED)("inserts into %s newest first by its own time, ties broken by id", (status) => {
    const prev = lists({
      draft: { posts: [summary("new", "draft"), summary("zz", "draft")] },
      [status]: { posts: [inSection("old", status, "2026-01-01T00:00:00.000Z"), inSection("aa", status, "2026-05-01T00:00:00.000Z")], total: 2 },
    });
    const withNew = applyPostMutationToLists(prev, inSection("new", status, "2026-03-01T00:00:00.000Z"), status, null);
    expect(ids(withNew[status].posts)).toEqual(["aa", "new", "old"]);
    expect(withNew[status].total).toBe(3);

    const withTie = applyPostMutationToLists(withNew, inSection("zz", status, "2026-05-01T00:00:00.000Z"), status, null);
    expect(ids(withTie[status].posts)).toEqual(["zz", "aa", "new", "old"]);
  });

  it("orders drafts newest-created first when inserting into a populated list", () => {
    const prev = lists({
      draft: { posts: [summary("old", "draft", { createdAtUtc: "2026-01-01T00:00:00.000Z" })] },
      verified: { posts: [summary("z", "verified")] },
    });
    const next = applyPostMutationToLists(
      prev,
      summary("z", "draft", { createdAtUtc: "2026-05-01T00:00:00.000Z" }),
      "draft",
      null
    );
    expect(ids(next.draft.posts)).toEqual(["z", "old"]);
  });

  it("tolerates posts with no section time when sorting", () => {
    const prev = lists({ retired: { posts: [summary("a", "retired")], total: 1 }, verified: { posts: [summary("b", "verified")] } });
    const next = applyPostMutationToLists(prev, summary("b", "retired"), "retired", null);
    expect(ids(next.retired.posts).sort()).toEqual(["a", "b"]);
  });
});

describe("removePostFromLists", () => {
  it.each(PAGED)("drops a deleted %s post and one from its total", (status) => {
    const prev = lists({ [status]: { posts: [inSection("a", status), inSection("b", status)], total: 7 } });
    const removed = removePostFromLists(prev, "a");
    expect(removed?.status).toBe(status);
    expect(ids(removed!.lists[status].posts)).toEqual(["b"]);
    expect(removed!.lists[status].total).toBe(6);
  });

  it("keeps a whole section's total its length", () => {
    const removed = removePostFromLists(lists({ draft: { posts: [summary("a", "draft")] } }), "a");
    expect(removed?.lists.draft).toEqual({ posts: [], total: 0 });
  });

  it("returns null for a post no loaded section holds", () => {
    expect(removePostFromLists(lists(), "ghost")).toBeNull();
  });
});

describe("listsFromResponse", () => {
  it("takes every section's posts and total", () => {
    const response = Object.fromEntries(
      (["draft", "discarded", "verified", "published", "retired"] as const).map((status, i) => [
        status,
        { posts: [summary(status, status)], total: i + 1, offset: 0 },
      ]),
    ) as PostListResponse;
    const next = listsFromResponse(response);
    expect(ids(next.retired.posts)).toEqual(["retired"]);
    expect(totals(next)).toEqual({ draft: 1, discarded: 2, verified: 3, published: 4, retired: 5 });
  });
});
