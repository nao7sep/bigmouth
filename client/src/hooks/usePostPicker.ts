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
}

export function usePostPicker(
  batchSize: number,
  excludeId?: string
): PostPickerState {
  const [allPosts, setAllPosts] = useState<PostSummary[]>([]);
  const [pubOffset, setPubOffset] = useState(0);
  const [pubTotal, setPubTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    loadingMoreRef.current = false;
    setLoadingMore(false);
    fetchPosts(0, batchSize)
      .then((data) => {
        const all = [...data.drafts, ...data.checked, ...data.published];
        setAllPosts(excludeId ? all.filter((p) => p.frontMatter.id !== excludeId) : all);
        setPubOffset(data.published.length);
        setPubTotal(data.publishedTotal);
      })
      .catch(() => {});
  }, [batchSize, excludeId]);

  const loadMore = () => {
    if (loadingMoreRef.current || query.trim() || pubOffset >= pubTotal) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);
    const requestOffset = pubOffset;

    fetchPosts(requestOffset, batchSize)
      .then((data) => {
        const next = excludeId
          ? data.published.filter((p) => p.frontMatter.id !== excludeId)
          : data.published;
        setAllPosts((prev) => {
          const seen = new Set(prev.map((p) => p.frontMatter.id));
          return [...prev, ...next.filter((p) => !seen.has(p.frontMatter.id))];
        });
        setPubOffset((o) => Math.max(o, requestOffset + data.published.length));
      })
      .catch(() => {})
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

  const hasMore = !lowerQuery && pubOffset < pubTotal;

  return { posts, hasMore, loadingMore, loadMore, query, setQuery };
}
