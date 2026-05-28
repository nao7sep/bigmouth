import type {
  Post,
  PostListResponse,
  AnalysisPrompt,
  Settings,
  Target,
  AssetMeta,
  AiConfig,
  AiConfigsData,
  GenerationPromptsData,
  ImagingOptions,
  Workspace,
  ImagingRelation,
  ImagingMood,
  ImagingLiteralness,
  ImagingPeople,
  ImagingStyle,
} from "./types";

// --- Workspace context ---

let wsId = "";
const METADATA_GENERATION_TIMEOUT_MS = 95_000;
const IMAGING_GENERATION_TIMEOUT_MS = 130_000;

export function setActiveWorkspace(id: string): void {
  wsId = id;
}

function base(workspaceId = wsId): string {
  if (!workspaceId) throw new Error("No active workspace set");
  return `/api/w/${workspaceId}`;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  timeoutMessage: string
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const upstreamSignal = init.signal;
  const abortFromUpstream = () => controller.abort();
  if (upstreamSignal?.aborted) {
    controller.abort();
  } else {
    upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  }
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (
      (err instanceof DOMException && err.name === "AbortError") ||
      (err instanceof Error && err.name === "AbortError")
    ) {
      if (!timedOut) throw err;
      throw new Error(timeoutMessage);
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
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

export async function revealCurrentLogFile(): Promise<string> {
  const res = await fetch("/api/logs/current/reveal", { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Failed to reveal current log file: ${res.status}`
    );
  }
  const data = (await res.json()) as { path: string };
  return data.path;
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

export async function createAiConfig(input: {
  id: string;
  name: string;
  provider: AiConfig["provider"];
  model: string;
  apiKey?: string;
}): Promise<AiConfigsData> {
  const res = await fetch(`${base()}/ai-configs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Failed to create AI config: ${res.status}`
    );
  }
  return res.json();
}

export async function updateAiConfig(
  id: string,
  patch: {
    name?: string;
    provider?: AiConfig["provider"];
    model?: string;
    /** Omit to preserve, "" to clear, non-empty to replace. */
    apiKey?: string;
  }
): Promise<AiConfigsData> {
  const res = await fetch(`${base()}/ai-configs/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Failed to update AI config: ${res.status}`
    );
  }
  return res.json();
}

export async function deleteAiConfig(id: string): Promise<AiConfigsData> {
  const res = await fetch(`${base()}/ai-configs/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Failed to delete AI config: ${res.status}`
    );
  }
  return res.json();
}

export async function setActiveAiConfig(id: string): Promise<AiConfigsData> {
  const res = await fetch(`${base()}/ai-configs/active`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Failed to set active AI config: ${res.status}`
    );
  }
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

export async function renameTarget(
  oldName: string,
  newName: string
): Promise<{ targets: Target[]; postsUpdated: number }> {
  const res = await fetch(`${base()}/targets/rename`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oldName, newName }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Failed to rename target: ${res.status}`);
  }
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

type MetadataGenerationResults = Record<string, { value: string } | { error: string }>;

export async function generateMetadataField(
  postId: string,
  field: string,
  content: string
): Promise<string> {
  const results = await generateMetadataFields(postId, [field], content);
  const result = results[field];
  if (!result || !("value" in result)) {
    throw new Error(result?.error ?? `Failed to generate ${field}`);
  }
  return result.value;
}

export async function generateMetadataFields(
  postId: string,
  fields: string[],
  content: string
): Promise<MetadataGenerationResults> {
  const res = await fetchWithTimeout(
    `${base()}/metadata/generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postId, fields, content }),
    },
    METADATA_GENERATION_TIMEOUT_MS,
    "Metadata generation timed out"
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Metadata generation failed: ${res.status}`
    );
  }
  const data = await res.json() as { results: MetadataGenerationResults };
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

export async function runAnalysisStream(
  postId: string,
  promptName: string,
  content: string,
  options: {
    signal?: AbortSignal;
    onChunk: (delta: string) => void;
  }
): Promise<void> {
  const res = await fetch(`${base()}/analyze/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postId, promptName, content }),
    signal: options.signal,
  });
  if (!res.ok) {
    const message = await res.text().catch(() => "");
    throw new Error(message || `Analysis failed: ${res.status}`);
  }
  if (!res.body) {
    const fallback = await res.text();
    if (fallback) options.onChunk(fallback);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) options.onChunk(text);
    }
    const finalChunk = decoder.decode();
    if (finalChunk) options.onChunk(finalChunk);
  } finally {
    reader.releaseLock();
  }
}

export type {
  ImagingOptions,
  ImagingRelation,
  ImagingMood,
  ImagingLiteralness,
  ImagingPeople,
  ImagingStyle,
};

export async function generateImaging(
  postId: string,
  content: string,
  options: ImagingOptions,
  signal?: AbortSignal
): Promise<string[]> {
  const res = await fetchWithTimeout(
    `${base()}/imaging`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postId, content, ...options }),
      signal,
    },
    IMAGING_GENERATION_TIMEOUT_MS,
    "Imaging generation timed out"
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Imaging failed: ${res.status}`
    );
  }
  const data = (await res.json()) as { items: string[] };
  return data.items;
}

/**
 * Returns the URL for serving a raw asset file.
 */
export function assetUrl(postId: string, filename: string, workspaceId?: string): string {
  return `${base(workspaceId)}/assets/${postId}/${encodeURIComponent(filename)}/raw`;
}
