import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";

// The hook's only dependency is listPosts; mock it so the tests drive the
// load/pagination/error logic without real data.
vi.mock("@renderer/api", () => ({
  listPosts: vi.fn(),
}));

import { usePostPicker } from "@renderer/hooks/usePostPicker";
import { listPosts } from "@renderer/api";
import type { PostStatus, PostSummary } from "@shared/types";

const mockListPosts = vi.mocked(listPosts);

function summary(
  id: string,
  overrides: Partial<PostSummary["frontMatter"]> = {}
): PostSummary {
  return {
    frontMatter: {
      id,
      target: "blog",
      status: "draft" as PostStatus,
      language: "en",
      createdAtUtc: "2024-01-01T00:00:00.000Z",
      ...overrides,
    },
  };
}

function page(opts: {
  drafts?: PostSummary[];
  ready?: PostSummary[];
  published?: PostSummary[];
  publishedTotal?: number;
  publishedOffset?: number;
  expired?: PostSummary[];
  expiredTotal?: number;
  expiredOffset?: number;
}) {
  return {
    drafts: opts.drafts ?? [],
    ready: opts.ready ?? [],
    published: opts.published ?? [],
    publishedTotal: opts.publishedTotal ?? (opts.published?.length ?? 0),
    publishedOffset: opts.publishedOffset ?? 0,
    expired: opts.expired ?? [],
    expiredTotal: opts.expiredTotal ?? (opts.expired?.length ?? 0),
    expiredOffset: opts.expiredOffset ?? 0,
  };
}

beforeEach(() => {
  mockListPosts.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("usePostPicker", () => {
  it("combines drafts, ready, published, and expired on initial load", async () => {
    mockListPosts.mockResolvedValueOnce(
      page({
        drafts: [summary("d1")],
        ready: [summary("c1")],
        published: [summary("p1")],
        publishedTotal: 1,
        expired: [summary("e1", { status: "expired" })],
        expiredTotal: 1,
      })
    );

    const { result } = renderHook(() => usePostPicker(50));

    await waitFor(() => expect(result.current.posts).toHaveLength(4));
    expect(result.current.posts.map((p) => p.frontMatter.id)).toEqual(["d1", "c1", "p1", "e1"]);
    expect(result.current.error).toBeNull();
    expect(result.current.hasMore).toBe(false);
  });

  it("loads more when only the expired archive has further pages", async () => {
    mockListPosts.mockResolvedValueOnce(
      page({ expired: [summary("e1", { status: "expired" })], expiredTotal: 2 })
    );

    const { result } = renderHook(() => usePostPicker(1));
    await waitFor(() => expect(result.current.posts).toHaveLength(1));
    expect(result.current.hasMore).toBe(true);

    mockListPosts.mockResolvedValueOnce(
      page({
        expired: [summary("e2", { status: "expired" })],
        expiredTotal: 2,
        expiredOffset: 1,
      })
    );

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.posts).toHaveLength(2));
    expect(result.current.posts.map((p) => p.frontMatter.id)).toEqual(["e1", "e2"]);
    // The second fetch must request the expired archive from its current offset.
    expect(mockListPosts).toHaveBeenLastCalledWith(0, 1, 1);
  });

  it("excludes the current post id", async () => {
    mockListPosts.mockResolvedValueOnce(
      page({ drafts: [summary("keep"), summary("self")] })
    );

    const { result } = renderHook(() => usePostPicker(50, "self"));

    await waitFor(() => expect(result.current.posts).toHaveLength(1));
    expect(result.current.posts[0].frontMatter.id).toBe("keep");
  });

  it("filters by query across id, target, language, and title", async () => {
    mockListPosts.mockResolvedValueOnce(
      page({
        drafts: [
          summary("a", { title: "Hello world" }),
          summary("b", { title: "Something else" }),
        ],
      })
    );

    const { result } = renderHook(() => usePostPicker(50));
    await waitFor(() => expect(result.current.posts).toHaveLength(2));

    act(() => result.current.setQuery("hello"));
    expect(result.current.posts.map((p) => p.frontMatter.id)).toEqual(["a"]);
  });

  it("appends and de-duplicates overlapping pages on loadMore", async () => {
    mockListPosts.mockResolvedValueOnce(
      page({ published: [summary("p1")], publishedTotal: 3 })
    );

    const { result } = renderHook(() => usePostPicker(1));
    await waitFor(() => expect(result.current.posts).toHaveLength(1));
    expect(result.current.hasMore).toBe(true);

    // Second page re-includes p1 (must be de-duped) and adds p2.
    mockListPosts.mockResolvedValueOnce(
      page({ published: [summary("p1"), summary("p2")], publishedTotal: 3, publishedOffset: 1 })
    );

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.posts).toHaveLength(2));
    expect(result.current.posts.map((p) => p.frontMatter.id)).toEqual(["p1", "p2"]);
  });

  it("surfaces an error when the initial load fails", async () => {
    mockListPosts.mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() => usePostPicker(50));

    await waitFor(() => expect(result.current.error).toBe("network down"));
    expect(result.current.posts).toHaveLength(0);
  });

  it("keeps already-loaded posts when loadMore fails", async () => {
    mockListPosts.mockResolvedValueOnce(
      page({ published: [summary("p1")], publishedTotal: 3 })
    );

    const { result } = renderHook(() => usePostPicker(1));
    await waitFor(() => expect(result.current.posts).toHaveLength(1));

    mockListPosts.mockRejectedValueOnce(new Error("load more failed"));
    act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.error).toBe("load more failed"));
    expect(result.current.posts.map((p) => p.frontMatter.id)).toEqual(["p1"]);
  });
});
