import type {
  Post,
  PostStatus,
  PostMutationResult,
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
} from "@shared/types";
import {
  assetUrl as buildAssetUrl,
  type AiConfigInput,
  type AiConfigPatch,
  type MetadataGenerationResults,
  type PostUpdate,
} from "@shared/ipc";

// The renderer's single data seam. Every call forwards to the preload bridge
// (`window.bigmouth`) over IPC. The active workspace id is tracked here and
// threaded into each workspace-scoped call.
const bridge = () => window.bigmouth;

let wsId = "";

export function setActiveWorkspace(id: string): void {
  wsId = id;
}

function requireWs(workspaceId = wsId): string {
  if (!workspaceId) throw new Error("No active workspace set");
  return workspaceId;
}

// --- Workspace management (no workspace context) ---

export function listWorkspaces(): Promise<Workspace[]> {
  return bridge().listWorkspaces();
}

export function openOrCreateWorkspace(name?: string, dataDirectory?: string): Promise<Workspace> {
  return bridge().openOrCreateWorkspace(name, dataDirectory);
}

export function updateWorkspace(
  id: string,
  updates: { name?: string; dataDirectory?: string },
): Promise<Workspace> {
  return bridge().updateWorkspace(id, updates);
}

export function deleteWorkspace(id: string): Promise<void> {
  return bridge().deleteWorkspace(id);
}

export function revealCurrentLogFile(): Promise<string> {
  return bridge().revealCurrentLogFile();
}

export function pickWorkspaceDirectory(): Promise<string | null> {
  return bridge().pickDirectory();
}

// --- Posts ---

export function listPosts(publishedOffset = 0, limit = 50, expiredOffset = 0): Promise<PostListResponse> {
  return bridge().listPosts(requireWs(), publishedOffset, limit, expiredOffset);
}

export function getPost(id: string, workspaceId?: string): Promise<Post> {
  return bridge().getPost(requireWs(workspaceId), id);
}

export function createPost(target: string, language: string, sourceId?: string): Promise<Post> {
  return bridge().createPost(requireWs(), target, language, sourceId);
}

export function updatePost(
  id: string,
  updates: {
    content?: string;
    frontMatter?: { [K in keyof Post["frontMatter"]]?: Post["frontMatter"][K] | null };
  },
  workspaceId?: string,
): Promise<PostMutationResult> {
  return bridge().updatePost(requireWs(workspaceId), id, updates as PostUpdate);
}

export function changePostStatus(
  id: string,
  status: PostStatus,
  workspaceId?: string,
): Promise<PostMutationResult> {
  return bridge().changePostStatus(requireWs(workspaceId), id, status);
}

export function deletePost(id: string, workspaceId?: string): Promise<void> {
  return bridge().deletePost(requireWs(workspaceId), id);
}

export function listReferrers(
  id: string,
  workspaceId?: string,
): Promise<{ count: number; ids: string[] }> {
  return bridge().listReferrers(requireWs(workspaceId), id);
}

export function rebuildPostIndex(): Promise<{ count: number }> {
  return bridge().rebuildPostIndex(requireWs());
}

// --- Targets ---

export function listTargets(): Promise<Target[]> {
  return bridge().listTargets(requireWs());
}

export function saveTargets(targets: Target[]): Promise<Target[]> {
  return bridge().saveTargets(requireWs(), targets);
}

export function renameTarget(
  oldName: string,
  newName: string,
): Promise<{ targets: Target[]; postsUpdated: number }> {
  return bridge().renameTarget(requireWs(), oldName, newName);
}

// --- Settings ---

export function getSettings(): Promise<Settings> {
  return bridge().getSettings(requireWs());
}

export function saveSettings(settings: Settings): Promise<Settings> {
  return bridge().saveSettings(requireWs(), settings);
}

// --- AI configs ---

export function listAiConfigs(): Promise<AiConfigsData> {
  return bridge().listAiConfigs(requireWs());
}

export function createAiConfig(input: {
  id: string;
  name: string;
  provider: AiConfig["provider"];
  model: string;
  apiKey?: string;
}): Promise<AiConfigsData> {
  return bridge().createAiConfig(requireWs(), input satisfies AiConfigInput);
}

export function updateAiConfig(
  id: string,
  patch: {
    name?: string;
    provider?: AiConfig["provider"];
    model?: string;
    /** Omit to preserve, "" to clear, non-empty to replace. */
    apiKey?: string;
  },
): Promise<AiConfigsData> {
  return bridge().updateAiConfig(requireWs(), id, patch satisfies AiConfigPatch);
}

export function deleteAiConfig(id: string): Promise<AiConfigsData> {
  return bridge().deleteAiConfig(requireWs(), id);
}

export function setActiveAiConfig(id: string): Promise<AiConfigsData> {
  return bridge().setActiveAiConfig(requireWs(), id);
}

// --- Generation prompts ---

export function getGenerationPrompts(): Promise<GenerationPromptsData> {
  return bridge().getGenerationPrompts(requireWs());
}

export function getGenerationPromptDefaults(): Promise<GenerationPromptsData> {
  return bridge().getGenerationPromptDefaults(requireWs());
}

export function saveGenerationPrompts(data: GenerationPromptsData): Promise<GenerationPromptsData> {
  return bridge().saveGenerationPrompts(requireWs(), data);
}

// --- Analysis prompts ---

export function listAnalysisPrompts(): Promise<AnalysisPrompt[]> {
  return bridge().listAnalysisPrompts(requireWs());
}

export function listAnalysisPromptDefaults(): Promise<AnalysisPrompt[]> {
  return bridge().listAnalysisPromptDefaults(requireWs());
}

export function saveAnalysisPrompts(prompts: AnalysisPrompt[]): Promise<AnalysisPrompt[]> {
  return bridge().saveAnalysisPrompts(requireWs(), prompts);
}

// --- Assets ---

export function listAssets(postId: string, workspaceId?: string): Promise<AssetMeta[]> {
  return bridge().listAssets(requireWs(workspaceId), postId);
}

export async function uploadAsset(postId: string, file: File, workspaceId?: string): Promise<AssetMeta> {
  // The picked File is read to bytes here and handed across the bridge.
  const data = await file.arrayBuffer();
  return bridge().uploadAsset(requireWs(workspaceId), postId, { name: file.name, data });
}

export function deleteAsset(postId: string, filename: string, workspaceId?: string): Promise<void> {
  return bridge().deleteAsset(requireWs(workspaceId), postId, filename);
}

// --- AI generation ---

export async function generateMetadataField(postId: string, field: string, content: string): Promise<string> {
  const results = await generateMetadataFields(postId, [field], content);
  const result = results[field];
  if (!result || !("value" in result)) {
    throw new Error(result?.error ?? `Failed to generate ${field}`);
  }
  return result.value;
}

export function generateMetadataFields(
  postId: string,
  fields: string[],
  content: string,
): Promise<MetadataGenerationResults> {
  return bridge().generateMetadata(requireWs(), postId, fields, content);
}

export function runAnalysisStream(
  postId: string,
  promptName: string,
  content: string,
  options: {
    signal?: AbortSignal;
    onChunk: (delta: string) => void;
  },
): Promise<void> {
  const handle = bridge().runAnalysisStream(
    { wsId: requireWs(), postId, promptName, content },
    options.onChunk,
  );
  const { signal } = options;
  if (signal) {
    if (signal.aborted) handle.abort();
    else signal.addEventListener("abort", () => handle.abort(), { once: true });
  }
  return handle.done;
}

export type {
  ImagingOptions,
  ImagingRelation,
  ImagingMood,
  ImagingLiteralness,
  ImagingPeople,
  ImagingStyle,
};

export function generateImaging(
  postId: string,
  content: string,
  options: ImagingOptions,
  signal?: AbortSignal,
): Promise<string[]> {
  const result = bridge().generateImaging(requireWs(), postId, content, options);
  if (!signal) return result;
  // The underlying generation can't be cancelled mid-call, but the caller's
  // abort still rejects this promise; the in-flight result is then discarded.
  return new Promise<string[]>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Imaging aborted", "AbortError"));
      return;
    }
    const onAbort = () => reject(new DOMException("Imaging aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    result.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The URL for serving a raw asset file through the custom protocol. */
export function assetUrl(postId: string, filename: string, workspaceId?: string): string {
  return buildAssetUrl(requireWs(workspaceId), postId, filename);
}
