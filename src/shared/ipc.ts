// The cross-process IPC contract: the typed surface the preload bridge exposes on
// `window.bigmouth`, implemented in preload (ipcRenderer.invoke + a streaming
// subscription) and backed by ipcMain handlers in the main process (Phase 3). Per
// the tsconfig-env-split-conventions this interface lives in `shared` so neither
// side imports a type from the other across the process line.
//
// One method per data operation, grouped by domain. Each workspace-scoped method
// takes the workspace id explicitly. DOM types never appear here (e.g. uploads
// cross as bytes, not `File`), keeping the contract valid under both the node and
// web typechecks.

import type {
  AiConfigsData,
  AiProvider,
  AnalysisPrompt,
  AssetMeta,
  EditablePostMetadata,
  GenerationPromptsData,
  ImagingOptions,
  Post,
  PostListResponse,
  PostMutationResult,
  PostStatus,
  Settings,
  Target,
  Workspace,
} from "./types";

// --- Channel names ---

export const CHANNELS = {
  // Workspace management
  listWorkspaces: "workspace:list",
  openOrCreateWorkspace: "workspace:openOrCreate",
  updateWorkspace: "workspace:update",
  deleteWorkspace: "workspace:delete",
  revealCurrentLogFile: "log:revealCurrent",
  pickDirectory: "dialog:pickDirectory",

  // Posts
  listPosts: "post:list",
  getPost: "post:get",
  createPost: "post:create",
  updatePost: "post:update",
  changePostStatus: "post:status",
  deletePost: "post:delete",
  listReferrers: "post:referrers",
  rebuildPostIndex: "post:rebuildIndex",

  // Targets
  listTargets: "target:list",
  saveTargets: "target:save",
  renameTarget: "target:rename",

  // Settings
  getSettings: "settings:get",
  saveSettings: "settings:save",

  // AI configs
  listAiConfigs: "aiConfig:list",
  createAiConfig: "aiConfig:create",
  updateAiConfig: "aiConfig:update",
  deleteAiConfig: "aiConfig:delete",
  setActiveAiConfig: "aiConfig:setActive",

  // Generation prompts
  getGenerationPrompts: "generationPrompts:get",
  getGenerationPromptDefaults: "generationPrompts:defaults",
  saveGenerationPrompts: "generationPrompts:save",

  // Analysis prompts
  listAnalysisPrompts: "analysisPrompt:list",
  listAnalysisPromptDefaults: "analysisPrompt:defaults",
  saveAnalysisPrompts: "analysisPrompt:save",

  // Assets
  listAssets: "asset:list",
  uploadAsset: "asset:upload",
  deleteAsset: "asset:delete",

  // AI generation
  generateMetadata: "metadata:generate",
  analysisStreamStart: "analysis:stream:start",
  analysisStreamAbort: "analysis:stream:abort",
  generateImaging: "imaging:generate",
} as const;

/** The per-request event channel main pushes analysis-stream frames on. */
export function analysisStreamChannel(requestId: string): string {
  return `analysis:stream:${requestId}`;
}

// --- Raw asset serving (custom protocol) ---

/** The privileged scheme main registers to stream raw asset files to <img> etc. */
export const ASSET_SCHEME = "bigmouth-asset";

/**
 * Builds the URL for an asset file under the custom protocol. The workspace,
 * post, and file are URL-encoded path segments under a fixed `asset` host (the
 * host is lowercased by URL parsing, so the case-sensitive ids stay in the path).
 */
export function assetUrl(wsId: string, postId: string, filename: string): string {
  return `${ASSET_SCHEME}://asset/${encodeURIComponent(wsId)}/${encodeURIComponent(postId)}/${encodeURIComponent(filename)}`;
}

// --- Method payload/result helpers ---

/** Raw bytes for an asset upload — the renderer reads the picked `File` to an
 * ArrayBuffer and hands the bytes over. */
export interface AssetUploadInput {
  name: string;
  data: ArrayBuffer;
}

export interface PostUpdate {
  content?: string;
  frontMatter?: EditablePostMetadata;
}

export interface AiConfigInput {
  id: string;
  name: string;
  provider: AiProvider;
  model: string;
  apiKey?: string;
}

export interface AiConfigPatch {
  name?: string;
  provider?: AiProvider;
  model?: string;
  /** Omit to preserve, "" to clear, non-empty to replace. */
  apiKey?: string;
}

export type MetadataGenerationResults = Record<string, { value: string } | { error: string }>;

export interface AnalysisStreamParams {
  wsId: string;
  postId: string;
  promptName: string;
  content: string;
}

/** One frame main pushes on the per-request analysis-stream channel. The explicit
 * done/error framing is what lets the renderer tell a complete analysis from one
 * cut short, so a partial result is never mistaken for a complete one. */
export type AnalysisStreamFrame =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** Handle returned by `runAnalysisStream`: a promise that settles with the stream
 * and an `abort` to cancel the in-flight generation. */
export interface AnalysisStreamHandle {
  done: Promise<void>;
  abort: () => void;
}

// --- The bridge surface ---

export interface BigMouthApi {
  // Workspace management
  listWorkspaces(): Promise<Workspace[]>;
  openOrCreateWorkspace(name?: string, dataDirectory?: string): Promise<Workspace>;
  updateWorkspace(id: string, updates: { name?: string; dataDirectory?: string }): Promise<Workspace>;
  deleteWorkspace(id: string): Promise<void>;
  revealCurrentLogFile(): Promise<string>;
  /** Native folder picker for choosing a workspace directory; null if cancelled. */
  pickDirectory(): Promise<string | null>;

  // Posts
  listPosts(wsId: string, publishedOffset: number, limit: number, expiredOffset: number): Promise<PostListResponse>;
  getPost(wsId: string, id: string): Promise<Post>;
  createPost(wsId: string, target: string, language: string, sourceId?: string): Promise<Post>;
  updatePost(wsId: string, id: string, updates: PostUpdate): Promise<PostMutationResult>;
  changePostStatus(wsId: string, id: string, status: PostStatus): Promise<PostMutationResult>;
  deletePost(wsId: string, id: string): Promise<void>;
  listReferrers(wsId: string, id: string): Promise<{ count: number; ids: string[] }>;
  rebuildPostIndex(wsId: string): Promise<{ count: number }>;

  // Targets
  listTargets(wsId: string): Promise<Target[]>;
  saveTargets(wsId: string, targets: Target[]): Promise<Target[]>;
  renameTarget(wsId: string, oldName: string, newName: string): Promise<{ targets: Target[]; postsUpdated: number }>;

  // Settings
  getSettings(wsId: string): Promise<Settings>;
  saveSettings(wsId: string, settings: Settings): Promise<Settings>;

  // AI configs
  listAiConfigs(wsId: string): Promise<AiConfigsData>;
  createAiConfig(wsId: string, input: AiConfigInput): Promise<AiConfigsData>;
  updateAiConfig(wsId: string, id: string, patch: AiConfigPatch): Promise<AiConfigsData>;
  deleteAiConfig(wsId: string, id: string): Promise<AiConfigsData>;
  setActiveAiConfig(wsId: string, id: string): Promise<AiConfigsData>;

  // Generation prompts
  getGenerationPrompts(wsId: string): Promise<GenerationPromptsData>;
  getGenerationPromptDefaults(wsId: string): Promise<GenerationPromptsData>;
  saveGenerationPrompts(wsId: string, data: GenerationPromptsData): Promise<GenerationPromptsData>;

  // Analysis prompts
  listAnalysisPrompts(wsId: string): Promise<AnalysisPrompt[]>;
  listAnalysisPromptDefaults(wsId: string): Promise<AnalysisPrompt[]>;
  saveAnalysisPrompts(wsId: string, prompts: AnalysisPrompt[]): Promise<AnalysisPrompt[]>;

  // Assets
  listAssets(wsId: string, postId: string): Promise<AssetMeta[]>;
  uploadAsset(wsId: string, postId: string, file: AssetUploadInput): Promise<AssetMeta>;
  deleteAsset(wsId: string, postId: string, filename: string): Promise<void>;

  // AI generation
  generateMetadata(wsId: string, postId: string, fields: string[], content: string): Promise<MetadataGenerationResults>;
  runAnalysisStream(params: AnalysisStreamParams, onDelta: (delta: string) => void): AnalysisStreamHandle;
  generateImaging(wsId: string, postId: string, content: string, options: ImagingOptions): Promise<string[]>;
}
