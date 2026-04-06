import { useEffect, useState } from "react";
import { fetchPosts } from "../api";
import type { PostSummary } from "../types";

export interface PostPickerState {
  posts: PostSummary[];
  hasMore: boolean;
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

  useEffect(() => {
    fetchPosts(0, batchSize)
      .then((data) => {
        const all = [...data.drafts, ...data.ready, ...data.published];
        setAllPosts(excludeId ? all.filter((p) => p.frontMatter.id !== excludeId) : all);
        setPubOffset(data.published.length);
        setPubTotal(data.publishedTotal);
      })
      .catch(() => {});
  }, [batchSize, excludeId]);

  const loadMore = () => {
    fetchPosts(pubOffset, batchSize)
      .then((data) => {
        const next = excludeId
          ? data.published.filter((p) => p.frontMatter.id !== excludeId)
          : data.published;
        setAllPosts((prev) => [...prev, ...next]);
        setPubOffset((o) => o + data.published.length);
      })
      .catch(() => {});
  };

  const lowerQuery = query.trim().toLowerCase();
  const posts = lowerQuery
    ? allPosts.filter((p) => {
        const fm = p.frontMatter;
        return [fm.id, fm.target, fm.language, fm.title ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(lowerQuery);
      })
    : allPosts;

  const hasMore = !lowerQuery && pubOffset < pubTotal;

  return { posts, hasMore, loadMore, query, setQuery };
}
