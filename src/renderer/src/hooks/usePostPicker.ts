import { useEffect, useRef, useState } from "react";
import { listPosts } from "../api";
import { FIRST_PAGES, PAGED_POST_STATUSES, POST_STATUSES, type PagedPostStatus } from "@shared/postStatus";
import { presentFailure } from "../util/presentFailure";
import type { PostSummary } from "@shared/types";
import { message, type Message } from "@shared/i18n/translate";

export interface PostPickerState {
  posts: PostSummary[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  query: string;
  setQuery: (q: string) => void;
  error: Message | null;
}

export function usePostPicker(
  batchSize: number,
  excludeId?: string
): PostPickerState {
  const [allPosts, setAllPosts] = useState<PostSummary[]>([]);
  // How far each paged section has been read, and how many posts it holds.
  const [offsets, setOffsets] = useState<PagedCounts>(FIRST_PAGES);
  const [totals, setTotals] = useState<PagedCounts>(FIRST_PAGES);
  const [query, setQuery] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const loadingMoreRef = useRef(false);
  const generationRef = useRef(0);

  const keep = (posts: PostSummary[]) =>
    excludeId ? posts.filter((p) => p.frontMatter.id !== excludeId) : posts;

  useEffect(() => {
    const generation = ++generationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(false);
    setError(null);
    setOffsets(FIRST_PAGES);
    setTotals(FIRST_PAGES);
    setAllPosts([]);
    listPosts(FIRST_PAGES, batchSize)
      .then((data) => {
        if (generation !== generationRef.current) return;
        setAllPosts(keep(POST_STATUSES.flatMap((status) => data[status].posts)));
        setOffsets(pagedValues((status) => data[status].posts.length));
        setTotals(pagedValues((status) => data[status].total));
      })
      .catch((err) => {
        if (generation !== generationRef.current) return;
        setError(presentFailure(message("picker.loadFailed"), "renderer: post picker load failed", err));
      })
      .finally(() => {
        if (generation !== generationRef.current) return;
        loadingMoreRef.current = false;
      });
    return () => { generationRef.current += 1; };
  }, [batchSize, excludeId]);

  const canLoadMore = PAGED_POST_STATUSES.some((status) => offsets[status] < totals[status]);

  const loadMore = () => {
    if (loadingMoreRef.current || query.trim() || !canLoadMore) {
      return;
    }

    loadingMoreRef.current = true;
    setLoadingMore(true);
    setError(null);
    // One fetch advances every paged section from its own offset, so the
    // combined picker list keeps growing past the first page.
    const requested = offsets;
    const generation = generationRef.current;

    listPosts(requested, batchSize)
      .then((data) => {
        if (generation !== generationRef.current) return;
        const incoming = keep(PAGED_POST_STATUSES.flatMap((status) => data[status].posts));
        setAllPosts((prev) => {
          const seen = new Set(prev.map((p) => p.frontMatter.id));
          return [...prev, ...incoming.filter((p) => !seen.has(p.frontMatter.id))];
        });
        setOffsets((current) =>
          pagedValues((status) => Math.max(current[status], requested[status] + data[status].posts.length)),
        );
      })
      .catch((err) => {
        if (generation !== generationRef.current) return;
        setError(presentFailure(message("picker.moreFailed"), "renderer: post picker pagination failed", err));
      })
      .finally(() => {
        if (generation !== generationRef.current) return;
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  };

  const lowerQuery = query.trim().toLowerCase();
  const posts = lowerQuery
    ? allPosts.filter((p) => {
        const fm = p.frontMatter;
        return [fm.id, fm.target, fm.language, fm.title ?? "", fm.titleEn ?? "", fm.excerpt ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(lowerQuery);
      })
    : allPosts;

  const hasMore = !lowerQuery && canLoadMore;

  return { posts, hasMore, loadingMore, loadMore, query, setQuery, error };
}

type PagedCounts = Readonly<Record<PagedPostStatus, number>>;

function pagedValues(value: (status: PagedPostStatus) => number): PagedCounts {
  return Object.fromEntries(PAGED_POST_STATUSES.map((status) => [status, value(status)])) as PagedCounts;
}
