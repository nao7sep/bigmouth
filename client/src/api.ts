import type { Post, PostListResponse, Prompt, Settings, Target } from "./types";

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
  language: string,
  sourceId?: string
): Promise<Post> {
  const res = await fetch("/api/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, language, sourceId }),
  });
  if (!res.ok) throw new Error(`Failed to create post: ${res.status}`);
  return res.json();
}

export async function updatePost(
  id: string,
  updates: { content?: string; frontMatter?: Partial<Post["frontMatter"]> }
): Promise<Post> {
  const res = await fetch(`/api/posts/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`Failed to update post: ${res.status}`);
  return res.json();
}

export async function changePostStatus(
  id: string,
  status: "draft" | "ready" | "published"
): Promise<Post> {
  const res = await fetch(`/api/posts/${id}/status`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to change status: ${res.status}`);
  }
  return res.json();
}

export async function deletePost(id: string): Promise<void> {
  const res = await fetch(`/api/posts/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete post: ${res.status}`);
}

export async function fetchTargets(): Promise<Target[]> {
  const res = await fetch("/api/targets");
  if (!res.ok) throw new Error(`Failed to fetch targets: ${res.status}`);
  return res.json();
}

export async function fetchSettings(): Promise<Settings> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error(`Failed to fetch settings: ${res.status}`);
  return res.json();
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error(`Failed to save settings: ${res.status}`);
  return res.json();
}

export async function saveTargets(targets: Target[]): Promise<Target[]> {
  const res = await fetch("/api/targets", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(targets),
  });
  if (!res.ok) throw new Error(`Failed to save targets: ${res.status}`);
  return res.json();
}

export async function fetchPrompts(): Promise<Prompt[]> {
  const res = await fetch("/api/prompts");
  if (!res.ok) throw new Error(`Failed to fetch prompts: ${res.status}`);
  return res.json();
}

export async function savePrompts(prompts: Prompt[]): Promise<Prompt[]> {
  const res = await fetch("/api/prompts", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(prompts),
  });
  if (!res.ok) throw new Error(`Failed to save prompts: ${res.status}`);
  return res.json();
}
