import type { Post, PostListResponse, AnalysisPrompt, Settings, Target, AssetMeta, AiConfigsData, GenerationPromptsData } from "./types";

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
  updates: {
    content?: string;
    frontMatter?: { [K in keyof Post["frontMatter"]]?: Post["frontMatter"][K] | null };
  }
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

export async function fetchAiConfigs(): Promise<AiConfigsData> {
  const res = await fetch("/api/ai-configs");
  if (!res.ok) throw new Error(`Failed to fetch AI configs: ${res.status}`);
  return res.json();
}

export async function saveAiConfigs(data: AiConfigsData): Promise<AiConfigsData> {
  const res = await fetch("/api/ai-configs", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to save AI configs: ${res.status}`);
  return res.json();
}

export async function fetchGenerationPrompts(): Promise<GenerationPromptsData> {
  const res = await fetch("/api/generation-prompts");
  if (!res.ok) throw new Error(`Failed to fetch generation prompts: ${res.status}`);
  return res.json();
}

export async function saveGenerationPrompts(data: GenerationPromptsData): Promise<GenerationPromptsData> {
  const res = await fetch("/api/generation-prompts", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to save generation prompts: ${res.status}`);
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

export async function fetchAnalysisPrompts(): Promise<AnalysisPrompt[]> {
  const res = await fetch("/api/analysis-prompts");
  if (!res.ok) throw new Error(`Failed to fetch prompts: ${res.status}`);
  return res.json();
}

export async function saveAnalysisPrompts(prompts: AnalysisPrompt[]): Promise<AnalysisPrompt[]> {
  const res = await fetch("/api/analysis-prompts", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(prompts),
  });
  if (!res.ok) throw new Error(`Failed to save prompts: ${res.status}`);
  return res.json();
}

export async function fetchAssets(postId: string): Promise<AssetMeta[]> {
  const res = await fetch(`/api/assets/${postId}`);
  if (!res.ok) throw new Error(`Failed to fetch assets: ${res.status}`);
  return res.json();
}

export async function uploadAsset(
  postId: string,
  file: File
): Promise<AssetMeta> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/assets/${postId}`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json();
}

export async function deleteAsset(
  postId: string,
  filename: string
): Promise<void> {
  const res = await fetch(`/api/assets/${postId}/${encodeURIComponent(filename)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

export async function generateMetadata(
  postId: string,
  field: string
): Promise<string> {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postId, field }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Generate failed: ${res.status}`
    );
  }
  const data = (await res.json()) as { value: string };
  return data.value;
}

export async function generateMetadataBatch(
  postId: string,
  fields: string[]
): Promise<Record<string, { value: string } | { error: string }>> {
  const res = await fetch("/api/generate/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postId, fields }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Batch generate failed: ${res.status}`
    );
  }
  const data = await res.json() as { results: Record<string, { value: string } | { error: string }> };
  return data.results;
}

export async function runAnalysis(
  postId: string,
  promptName: string
): Promise<string> {
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postId, promptName }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Analysis failed: ${res.status}`
    );
  }
  const data = (await res.json()) as { result: string };
  return data.result;
}
