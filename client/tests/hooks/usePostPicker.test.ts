import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";

// The hook's only dependency is fetchPosts; mock it so the tests drive the
// load/pagination/error logic without touching the network.
vi.mock("../../src/api", () => ({
  fetchPosts: vi.fn(),
}));

import { usePostPicker } from "../../src/hooks/usePostPicker";
import { fetchPosts } from "../../src/api";
import type { PostStatus, PostSummary } from "../../src/types";

const mockFetchPosts = vi.mocked(fetchPosts);

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
  checked?: PostSummary[];
  published?: PostSummary[];
  publishedTotal?: number;
  publishedOffset?: number;
}) {
  return {
    drafts: opts.drafts ?? [],
    checked: opts.checked ?? [],
    published: opts.published ?? [],
    publishedTotal: opts.publishedTotal ?? (opts.published?.length ?? 0),
    publishedOffset: opts.publishedOffset ?? 0,
  };
}

beforeEach(() => {
  mockFetchPosts.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("usePostPicker", () => {
  it("combines drafts, checked, and published on initial load", async () => {
    mockFetchPosts.mockResolvedValueOnce(
      page({
        drafts: [summary("d1")],
        checked: [summary("c1")],
        published: [summary("p1")],
        publishedTotal: 1,
      })
    );

    const { result } = renderHook(() => usePostPicker(50));

    await waitFor(() => expect(result.current.posts).toHaveLength(3));
    expect(result.current.posts.map((p) => p.frontMatter.id)).toEqual(["d1", "c1", "p1"]);
    expect(result.current.error).toBeNull();
    expect(result.current.hasMore).toBe(false);
  });

  it("excludes the current post id", async () => {
    mockFetchPosts.mockResolvedValueOnce(
      page({ drafts: [summary("keep"), summary("self")] })
    );

    const { result } = renderHook(() => usePostPicker(50, "self"));

    await waitFor(() => expect(result.current.posts).toHaveLength(1));
    expect(result.current.posts[0].frontMatter.id).toBe("keep");
  });

  it("filters by query across id, target, language, and title", async () => {
    mockFetchPosts.mockResolvedValueOnce(
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
    mockFetchPosts.mockResolvedValueOnce(
      page({ published: [summary("p1")], publishedTotal: 3 })
    );

    const { result } = renderHook(() => usePostPicker(1));
    await waitFor(() => expect(result.current.posts).toHaveLength(1));
    expect(result.current.hasMore).toBe(true);

    // Second page re-includes p1 (must be de-duped) and adds p2.
    mockFetchPosts.mockResolvedValueOnce(
      page({ published: [summary("p1"), summary("p2")], publishedTotal: 3, publishedOffset: 1 })
    );

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.posts).toHaveLength(2));
    expect(result.current.posts.map((p) => p.frontMatter.id)).toEqual(["p1", "p2"]);
  });

  it("surfaces an error when the initial load fails", async () => {
    mockFetchPosts.mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() => usePostPicker(50));

    await waitFor(() => expect(result.current.error).toBe("network down"));
    expect(result.current.posts).toHaveLength(0);
  });

  it("keeps already-loaded posts when loadMore fails", async () => {
    mockFetchPosts.mockResolvedValueOnce(
      page({ published: [summary("p1")], publishedTotal: 3 })
    );

    const { result } = renderHook(() => usePostPicker(1));
    await waitFor(() => expect(result.current.posts).toHaveLength(1));

    mockFetchPosts.mockRejectedValueOnce(new Error("load more failed"));
    act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.error).toBe("load more failed"));
    expect(result.current.posts.map((p) => p.frontMatter.id)).toEqual(["p1"]);
  });
});
