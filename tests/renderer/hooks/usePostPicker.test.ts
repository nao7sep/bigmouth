import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

// The hook's only dependency is listPosts; mock it so the tests drive the
// load/pagination/error logic without real data.
vi.mock("@renderer/api", () => ({
  reportProblem: vi.fn(),
  listPosts: vi.fn(),
}));

import { usePostPicker } from "@renderer/hooks/usePostPicker";
import { listPosts } from "@renderer/api";
import type { PostListResponse, PostStatus, PostSummary } from "@shared/types";

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

type Sections = Partial<Record<PostStatus, PostSummary[]>>;

/** A list response holding `posts`, with `totals` for paged sections that have more. */
function page(posts: Sections, totals: Partial<Record<PostStatus, number>> = {}, offsets: Partial<Record<PostStatus, number>> = {}) {
  return Object.fromEntries(
    (["draft", "discarded", "verified", "published", "retired"] as const).map((status) => [
      status,
      { posts: posts[status] ?? [], total: totals[status] ?? posts[status]?.length ?? 0, offset: offsets[status] ?? 0 },
    ]),
  ) as PostListResponse;
}

// The mocked listPosts settles within the current macrotask, so one macrotask
// boundary inside act lets every resulting update land: a wait on that
// condition, not on the clock.
function settled(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  mockListPosts.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("usePostPicker", () => {
  it("combines every section, in status order, on initial load", async () => {
    mockListPosts.mockResolvedValueOnce(
      page({
        draft: [summary("d1")],
        discarded: [summary("x1", { status: "discarded" })],
        verified: [summary("v1", { status: "verified" })],
        published: [summary("p1", { status: "published" })],
        retired: [summary("r1", { status: "retired" })],
      })
    );

    const { result } = renderHook(() => usePostPicker(50));

    await settled();
    expect(result.current.posts).toHaveLength(5);
    expect(result.current.posts.map((p) => p.frontMatter.id)).toEqual(["d1", "x1", "v1", "p1", "r1"]);
    expect(result.current.error).toBeNull();
    expect(result.current.hasMore).toBe(false);
  });

  it.each(["discarded", "retired"] as const)("loads more when only the %s section has further pages", async (status) => {
    mockListPosts.mockResolvedValueOnce(page({ [status]: [summary("e1", { status })] }, { [status]: 2 }));

    const { result } = renderHook(() => usePostPicker(1));
    await settled();
    expect(result.current.posts).toHaveLength(1);
    expect(result.current.hasMore).toBe(true);

    mockListPosts.mockResolvedValueOnce(page({ [status]: [summary("e2", { status })] }, { [status]: 2 }, { [status]: 1 }));

    act(() => result.current.loadMore());
    await settled();
    expect(result.current.posts).toHaveLength(2);
    expect(result.current.posts.map((p) => p.frontMatter.id)).toEqual(["e1", "e2"]);
    // The second fetch must request that section from its current offset.
    expect(mockListPosts).toHaveBeenLastCalledWith({ discarded: 0, published: 0, retired: 0, [status]: 1 }, 1);
    expect(result.current.hasMore).toBe(false);
  });

  it("excludes the current post id", async () => {
    mockListPosts.mockResolvedValueOnce(
      page({ draft: [summary("keep"), summary("self")] })
    );

    const { result } = renderHook(() => usePostPicker(50, "self"));

    await settled();
    expect(result.current.posts).toHaveLength(1);
    expect(result.current.posts[0].frontMatter.id).toBe("keep");
  });

  it("filters by query across id, target, language, and title", async () => {
    mockListPosts.mockResolvedValueOnce(
      page({
        draft: [
          summary("a", { title: "Hello world" }),
          summary("b", { title: "Something else" }),
        ],
      })
    );

    const { result } = renderHook(() => usePostPicker(50));
    await settled();
    expect(result.current.posts).toHaveLength(2);

    act(() => result.current.setQuery("hello"));
    expect(result.current.posts.map((p) => p.frontMatter.id)).toEqual(["a"]);
  });

  it("appends and de-duplicates overlapping pages on loadMore", async () => {
    mockListPosts.mockResolvedValueOnce(
      page({ published: [summary("p1")] }, { published: 3 })
    );

    const { result } = renderHook(() => usePostPicker(1));
    await settled();
    expect(result.current.posts).toHaveLength(1);
    expect(result.current.hasMore).toBe(true);

    // Second page re-includes p1 (must be de-duped) and adds p2.
    mockListPosts.mockResolvedValueOnce(
      page({ published: [summary("p1"), summary("p2")] }, { published: 3 }, { published: 1 })
    );

    act(() => result.current.loadMore());
    await settled();
    expect(result.current.posts).toHaveLength(2);
    expect(result.current.posts.map((p) => p.frontMatter.id)).toEqual(["p1", "p2"]);
  });

  it("surfaces an error when the initial load fails", async () => {
    mockListPosts.mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() => usePostPicker(50));

    await settled();
    expect(result.current.error).toEqual({ key: "picker.loadFailed" });
    expect(result.current.posts).toHaveLength(0);
  });

  it("keeps already-loaded posts when loadMore fails", async () => {
    mockListPosts.mockResolvedValueOnce(
      page({ published: [summary("p1")] }, { published: 3 })
    );

    const { result } = renderHook(() => usePostPicker(1));
    await settled();
    expect(result.current.posts).toHaveLength(1);

    mockListPosts.mockRejectedValueOnce(new Error("load more failed"));
    act(() => result.current.loadMore());

    await settled();
    expect(result.current.error).toEqual({ key: "picker.moreFailed" });
    expect(result.current.posts.map((p) => p.frontMatter.id)).toEqual(["p1"]);
  });
});
