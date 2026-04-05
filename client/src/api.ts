import type { Post, PostListResponse, Target } from "./types";

export async function fetchPosts(
  publishedOffset = 0,
  limit = 50
): Promise<PostListResponse> {
  const params = new URLSearchParams({
    publishedOffset: String(publishedOffset),
    limit: String(limit),
  });
  const res = await fetch(`/api/posts?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch posts: ${res.status}`);
  return res.json();
}

export async function fetchPost(id: string): Promise<Post> {
  const res = await fetch(`/api/posts/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch post: ${res.status}`);
  return res.json();
}

export async function createPost(
  target: string,
  language: string
): Promise<Post> {
  const res = await fetch("/api/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, language }),
  });
  if (!res.ok) throw new Error(`Failed to create post: ${res.status}`);
  return res.json();
}

export async function fetchTargets(): Promise<Target[]> {
  const res = await fetch("/api/targets");
  if (!res.ok) throw new Error(`Failed to fetch targets: ${res.status}`);
  return res.json();
}
