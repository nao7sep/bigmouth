import { useEffect, useRef, useState } from "react";
import { fetchPosts } from "../api";
import type { PostSummary } from "../types";

export interface PostPickerState {
  posts: PostSummary[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  query: string;
  setQuery: (q: string) => void;
  error: string | null;
}

export function usePostPicker(
  batchSize: number,
  excludeId?: string
): PostPickerState {
  const [allPosts, setAllPosts] = useState<PostSummary[]>([]);
  const [pubOffset, setPubOffset] = useState(0);
  const [pubTotal, setPubTotal] = useState(0);
  const [expOffset, setExpOffset] = useState(0);
  const [expTotal, setExpTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setError(null);
    fetchPosts(0, batchSize, 0)
      .then((data) => {
        const all = [...data.drafts, ...data.checked, ...data.published, ...data.expired];
        setAllPosts(excludeId ? all.filter((p) => p.frontMatter.id !== excludeId) : all);
        setPubOffset(data.published.length);
        setPubTotal(data.publishedTotal);
        setExpOffset(data.expired.length);
        setExpTotal(data.expiredTotal);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load posts."));
  }, [batchSize, excludeId]);

  const loadMore = () => {
    if (loadingMoreRef.current || query.trim() || (pubOffset >= pubTotal && expOffset >= expTotal)) {
      return;
    }

    loadingMoreRef.current = true;
    setLoadingMore(true);
    setError(null);
    // One fetch advances both archives — published from pubOffset, expired from
    // expOffset — so the combined picker list keeps growing past the first page.
    const requestPubOffset = pubOffset;
    const requestExpOffset = expOffset;

    fetchPosts(requestPubOffset, batchSize, requestExpOffset)
      .then((data) => {
        const incoming = [...data.published, ...data.expired];
        const next = excludeId
          ? incoming.filter((p) => p.frontMatter.id !== excludeId)
          : incoming;
        setAllPosts((prev) => {
          const seen = new Set(prev.map((p) => p.frontMatter.id));
          return [...prev, ...next.filter((p) => !seen.has(p.frontMatter.id))];
        });
        setPubOffset((o) => Math.max(o, requestPubOffset + data.published.length));
        setExpOffset((o) => Math.max(o, requestExpOffset + data.expired.length));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load more posts."))
      .finally(() => {
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

  const hasMore = !lowerQuery && (pubOffset < pubTotal || expOffset < expTotal);

  return { posts, hasMore, loadingMore, loadMore, query, setQuery, error };
}
