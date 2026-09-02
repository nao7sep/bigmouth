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
  PostIndexEntry,
  PostListResponse,
  PostMutationResult,
  PostStatus,
  Settings,
  Target,
  UiState,
  Workspace,
} from "./types";

/**
 * One renderer-side event for the session log. `detail` carries whatever the
 * call site knows — a serialized error, an id, a count; main redacts it like any
 * other log field before writing.
 */
export interface RendererLogEntry {
  level: "warn" | "error";
  message: string;
  detail?: Record<string, unknown>;
}

// --- Channel names ---

export const CHANNELS = {
  // Workspace management
  listWorkspaces: "workspace:list",
  openOrCreateWorkspace: "workspace:openOrCreate",
  updateWorkspace: "workspace:update",
  deleteWorkspace: "workspace:delete",
  revealCurrentLogFile: "log:revealCurrent",
  // The renderer's only way into the session log: it is sandboxed and opens no
  // file of its own, so it forwards a structured record to main (logging
  // conventions, "Multi-process apps"). One-way and fire-and-forget — a failure
  // to log must never become a second failure the caller has to handle.
  writeRendererLog: "log:write",
  pickDirectory: "dialog:pickDirectory",

  // UI state (state.json)
  getUiState: "state:get",
  updateUiState: "state:update",

  // Posts
  listPosts: "post:list",
  getPost: "post:get",
  createPost: "post:create",
  updatePost: "post:update",
  changePostStatus: "post:status",
  deletePost: "post:delete",
  listReferrers: "post:referrers",
  rebuildPostIndex: "post:rebuildIndex",
  // Content streaming: renderer fires every editor change at the main process,
  // which owns coalescing and disk writes (write-behind in the post store).
  queuePostContent: "post:queueContent",
  postContentSaved: "post:contentSaved",
  postContentSaveFailed: "post:contentSaveFailed",

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

// --- Content-save events (main -> renderer) ---

export interface PostContentSavedEvent {
  postId: string;
  /**
   * The canonical list projection (one index row). It carries no updatedAtUtc —
   * the index deliberately excludes it — so this is a list summary, never a
   * source for the post's edit time.
   */
  summary: PostIndexEntry;
}

export interface PostContentSaveFailedEvent {
  postId: string;
  /**
   * Which failure this is. "retrying": a write failed, the text is still
   * buffered in the main process and the store will try again. "unsaveable":
   * terminal — the post's file (or its workspace) is gone, so no retry can land
   * and the only copies left are the buffer and what the editor shows.
   */
  kind: "retrying" | "unsaveable";
  /** Why the save failed; a complete sentence for the terminal kind. */
  message: string;
}

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

/** Raw bytes for an asset upload. The sandboxed renderer also supplies optional
 * dimensions from Chromium's image decoder; main treats them as untrusted IPC
 * input and stores them only when they form a valid pair. */
export interface AssetUploadInput {
  name: string;
  data: ArrayBuffer;
  width?: number;
  height?: number;
}

/** Predictable upload admissions cross IPC as data, never serialized exceptions. */
export type AssetUploadAdmission =
  | { code: "file-too-large"; limitMb: number }
  | { code: "reserved-name"; filename: string }
  | { code: "post-locked"; status: "published" | "expired" };

export type AssetUploadResult =
  | { ok: true; asset: AssetMeta }
  | { ok: false; admission: AssetUploadAdmission };

export interface PostUpdate {
  content?: string;
  frontMatter?: EditablePostMetadata;
}

export interface AiConfigInput {
  id: string;
  name: string;
  provider: AiProvider;
  model: string;
  thinking: boolean;
  maxTokens: number;
  apiKey?: string;
}

export interface AiConfigPatch {
  name?: string;
  provider?: AiProvider;
  model?: string;
  thinking?: boolean;
  maxTokens?: number;
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
  // The model's reasoning summary, produced before the answer when the AI config has
  // thinking on. A separate frame so the renderer can show it as reasoning rather than
  // splicing it into the analysis text.
  | { type: "thinking"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** Handle returned by `runAnalysisStream`: a promise that settles with the stream
 * and an `abort` to cancel the in-flight generation. */
export interface AnalysisStreamHandle {
  done: Promise<void>;
  abort: () => void;
}

// --- The bridge surface ---

// The Node platform string (member set of NodeJS.Platform), spelled out as a
// portable union so this shared contract carries no @types/node dependency — it
// is imported by the renderer, which is typechecked without Node types.
export type Platform =
  | "aix"
  | "android"
  | "darwin"
  | "freebsd"
  | "haiku"
  | "linux"
  | "openbsd"
  | "sunos"
  | "win32"
  | "cygwin"
  | "netbsd";

export interface BigMouthApi {
  /** The running OS, exposed synchronously from the preload (process.platform). */
  platform: Platform;

  // Workspace management
  listWorkspaces(): Promise<Workspace[]>;
  openOrCreateWorkspace(name?: string, dataDirectory?: string): Promise<Workspace>;
  /** Renames a workspace. A workspace's folder is where it is; there is no relocation. */
  updateWorkspace(id: string, updates: { name: string }): Promise<Workspace>;
  deleteWorkspace(id: string): Promise<void>;
  revealCurrentLogFile(): Promise<string>;
  /** Native folder picker for choosing a workspace directory; null if cancelled. */
  pickDirectory(): Promise<string | null>;

  // UI state (state.json) — persisted view state: side-pane widths and the last
  // active workspace id. Its own store, separate from workspace config.
  getUiState(): Promise<UiState>;
  updateUiState(patch: Partial<UiState>): Promise<UiState>;

  // Posts
  listPosts(wsId: string, publishedOffset: number, limit: number, expiredOffset: number): Promise<PostListResponse>;
  getPost(wsId: string, id: string): Promise<Post>;
  createPost(wsId: string, target: string, language: string, sourceId?: string): Promise<Post>;
  updatePost(wsId: string, id: string, updates: PostUpdate): Promise<PostMutationResult>;
  /** Fire-and-forget: buffer a content edit in the main process, which owns the
   *  debounce, the disk write, and the flush at quit. Post ids are unique
   *  nanoids, so saved/failed events are matched by post id alone. */
  queuePostContent(wsId: string, id: string, content: string): void;
  onPostContentSaved(listener: (event: PostContentSavedEvent) => void): () => void;
  onPostContentSaveFailed(listener: (event: PostContentSaveFailedEvent) => void): () => void;
  changePostStatus(wsId: string, id: string, status: PostStatus): Promise<PostMutationResult>;
  deletePost(wsId: string, id: string): Promise<void>;
  listReferrers(wsId: string, id: string): Promise<{ count: number; ids: string[] }>;
  /**
   * `count` is what is now indexed, `skipped` how many files could not be read,
   * `duplicateSlugs` how many case-insensitive slug collisions remain, and
   * `orphanedAssets` how many asset folders belong to a post that is gone.
   */
  rebuildPostIndex(
    wsId: string,
  ): Promise<{ count: number; skipped: number; duplicateSlugs: number; orphanedAssets: number }>;

  /** Records a renderer-side warning or error in the session log. Fire-and-forget. */
  writeRendererLog(entry: RendererLogEntry): void;

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
  uploadAsset(wsId: string, postId: string, file: AssetUploadInput): Promise<AssetUploadResult>;
  deleteAsset(wsId: string, postId: string, filename: string): Promise<void>;

  // AI generation
  generateMetadata(wsId: string, postId: string, fields: string[], content: string): Promise<MetadataGenerationResults>;
  runAnalysisStream(
    params: AnalysisStreamParams,
    onDelta: (delta: string) => void,
    onThinking?: (delta: string) => void,
  ): AnalysisStreamHandle;
  generateImaging(wsId: string, postId: string, content: string, options: ImagingOptions): Promise<string[]>;
}
