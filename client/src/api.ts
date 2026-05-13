import type { Post, PostListResponse, AnalysisPrompt, Settings, Target, AssetMeta, AiConfigsData, GenerationPromptsData, Workspace } from "./types";

// --- Workspace context ---

let wsId = "";

export function setActiveWorkspace(id: string): void {
  wsId = id;
}

function base(workspaceId = wsId): string {
  if (!workspaceId) throw new Error("No active workspace set");
  return `/api/w/${workspaceId}`;
}

// --- Workspace management (no workspace prefix) ---

export async function fetchWorkspaces(): Promise<Workspace[]> {
  const res = await fetch("/api/workspaces");
  if (!res.ok) throw new Error(`Failed to fetch workspaces: ${res.status}`);
  return res.json();
}

export async function openOrCreateWorkspace(
  name?: string,
  dataDirectory?: string
): Promise<Workspace> {
  const res = await fetch("/api/workspaces/open-or-create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, dataDirectory }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Failed to open or create workspace: ${res.status}`
    );
  }
  return res.json();
}

export async function updateWorkspace(
  id: string,
  updates: { name?: string; dataDirectory?: string }
): Promise<Workspace> {
  const res = await fetch(`/api/workspaces/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`Failed to update workspace: ${res.status}`);
  return res.json();
}

export async function deleteWorkspace(id: string): Promise<void> {
  const res = await fetch(`/api/workspaces/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete workspace: ${res.status}`);
}

// --- Workspace-scoped API ---

export async function fetchPosts(
  publishedOffset = 0,
  limit = 50
): Promise<PostListResponse> {
  const params = new URLSearchParams({
    publishedOffset: String(publishedOffset),
    limit: String(limit),
  });
  const res = await fetch(`${base()}/posts?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch posts: ${res.status}`);
  return res.json();
}

export async function fetchPost(id: string, workspaceId?: string): Promise<Post> {
  const res = await fetch(`${base(workspaceId)}/posts/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch post: ${res.status}`);
  return res.json();
}

export async function createPost(
  target: string,
  language: string,
  sourceId?: string
): Promise<Post> {
  const res = await fetch(`${base()}/posts`, {
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
  },
  workspaceId?: string
): Promise<Post> {
  const res = await fetch(`${base(workspaceId)}/posts/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Failed to update post: ${res.status}`);
  }
  return res.json();
}

export async function changePostStatus(
  id: string,
  status: "draft" | "ready" | "published",
  workspaceId?: string
): Promise<Post> {
  const res = await fetch(`${base(workspaceId)}/posts/${id}/status`, {
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

export async function deletePost(id: string, workspaceId?: string): Promise<void> {
  const res = await fetch(`${base(workspaceId)}/posts/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete post: ${res.status}`);
}

export async function fetchTargets(): Promise<Target[]> {
  const res = await fetch(`${base()}/targets`);
  if (!res.ok) throw new Error(`Failed to fetch targets: ${res.status}`);
  return res.json();
}

export async function fetchSettings(): Promise<Settings> {
  const res = await fetch(`${base()}/settings`);
  if (!res.ok) throw new Error(`Failed to fetch settings: ${res.status}`);
  return res.json();
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  const res = await fetch(`${base()}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error(`Failed to save settings: ${res.status}`);
  return res.json();
}

export async function fetchAiConfigs(): Promise<AiConfigsData> {
  const res = await fetch(`${base()}/ai-configs`);
  if (!res.ok) throw new Error(`Failed to fetch AI configs: ${res.status}`);
  return res.json();
}

export async function saveAiConfigs(data: AiConfigsData): Promise<AiConfigsData> {
  const res = await fetch(`${base()}/ai-configs`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to save AI configs: ${res.status}`);
  return res.json();
}

export async function fetchGenerationPrompts(): Promise<GenerationPromptsData> {
  const res = await fetch(`${base()}/generation-prompts`);
  if (!res.ok) throw new Error(`Failed to fetch generation prompts: ${res.status}`);
  return res.json();
}

export async function fetchGenerationPromptDefaults(): Promise<GenerationPromptsData> {
  const res = await fetch(`${base()}/generation-prompts/defaults`);
  if (!res.ok) throw new Error(`Failed to fetch generation prompt defaults: ${res.status}`);
  return res.json();
}

export async function saveGenerationPrompts(data: GenerationPromptsData): Promise<GenerationPromptsData> {
  const res = await fetch(`${base()}/generation-prompts`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to save generation prompts: ${res.status}`);
  return res.json();
}

export async function saveTargets(targets: Target[]): Promise<Target[]> {
  const res = await fetch(`${base()}/targets`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(targets),
  });
  if (!res.ok) throw new Error(`Failed to save targets: ${res.status}`);
  return res.json();
}

export async function fetchAnalysisPrompts(): Promise<AnalysisPrompt[]> {
  const res = await fetch(`${base()}/analysis-prompts`);
  if (!res.ok) throw new Error(`Failed to fetch prompts: ${res.status}`);
  return res.json();
}

export async function fetchAnalysisPromptDefaults(): Promise<AnalysisPrompt[]> {
  const res = await fetch(`${base()}/analysis-prompts/defaults`);
  if (!res.ok) throw new Error(`Failed to fetch prompt defaults: ${res.status}`);
  return res.json();
}

export async function saveAnalysisPrompts(prompts: AnalysisPrompt[]): Promise<AnalysisPrompt[]> {
  const res = await fetch(`${base()}/analysis-prompts`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(prompts),
  });
  if (!res.ok) throw new Error(`Failed to save prompts: ${res.status}`);
  return res.json();
}

export async function fetchAssets(postId: string, workspaceId?: string): Promise<AssetMeta[]> {
  const res = await fetch(`${base(workspaceId)}/assets/${postId}`);
  if (!res.ok) throw new Error(`Failed to fetch assets: ${res.status}`);
  return res.json();
}

export async function uploadAsset(
  postId: string,
  file: File,
  workspaceId?: string
): Promise<AssetMeta> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${base(workspaceId)}/assets/${postId}`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Upload failed: ${res.status}`);
  }
  return res.json();
}

export async function deleteAsset(
  postId: string,
  filename: string,
  workspaceId?: string
): Promise<void> {
  const res = await fetch(`${base(workspaceId)}/assets/${postId}/${encodeURIComponent(filename)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Delete failed: ${res.status}`);
  }
}

export async function generateMetadata(
  postId: string,
  field: string,
  content: string
): Promise<string> {
  const res = await fetch(`${base()}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postId, field, content }),
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
  fields: string[],
  content: string
): Promise<Record<string, { value: string } | { error: string }>> {
  const res = await fetch(`${base()}/generate/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postId, fields, content }),
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
  promptName: string,
  content: string
): Promise<string> {
  const res = await fetch(`${base()}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postId, promptName, content }),
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

/**
 * Returns the URL for serving a raw asset file.
 */
export function assetUrl(postId: string, filename: string, workspaceId?: string): string {
  return `${base(workspaceId)}/assets/${postId}/${encodeURIComponent(filename)}/raw`;
}
