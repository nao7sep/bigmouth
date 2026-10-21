// The cross-process IPC contract: the typed surface the preload bridge exposes on
// `window.bigmouth`, implemented in preload (ipcRenderer.invoke + a streaming
// subscription) and backed by ipcMain handlers in the main process (Phase 3). Per
// the tsconfig-env-split-conventions this interface lives in `shared` so neither
// side imports a type from the other across the process line.
//
// One method per data operation, grouped by domain. Each workspace-scoped method
// takes the workspace id explicitly. The only DOM type here is `File`, which Node
// declares too, so the contract holds under both the node and web typechecks: the
// renderer hands a picked file to the preload, which streams its bytes to main.

import type {
  AnthropicSettingsInput,
  AnthropicSettingsView,
  AppSettings,
  AppSettingsView,
  AnalysisPrompt,
  AssetListing,
  AssetMeta,
  EditablePostMetadata,
  GenerationPromptsData,
  ImagingOptions,
  Post,
  PostDeleteResult,
  PostIndexEntry,
  PostListResponse,
  PostMutationResult,
  PostStatus,
  Settings,
  Target,
  UiState,
  Workspace,
  WorkspaceDeleteResult,
} from "./types";
import type { PagedPostStatus } from "./postStatus";
import type { InterfaceLanguage } from "./i18n/languages";
import type { Message } from "./i18n/translate";
import type { RecordDetail, RecordKind, RecordSources, RecordsPage, RecordsQuery } from "./records";

/**
 * What a target rename did. `postsSkipped` names the post files it could not
 * read: they still carry the old target name, which the rename just retired.
 */
export interface TargetRenameResult {
  targets: Target[];
  postsUpdated: number;
  postsSkipped: { fileName: string; reason: string }[];
}

/**
 * One renderer-side event for the session log. `detail` carries whatever the
 * call site knows — a serialized error, an id, a count; main writes it like any
 * other log field.
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
  createWorkspace: "workspace:create",
  addExistingWorkspace: "workspace:addExisting",
  suggestWorkspaceLocation: "workspace:suggestLocation",
  updateWorkspace: "workspace:update",
  deleteWorkspace: "workspace:delete",
  openExternal: "shell:openExternal",
  // The renderer's only way into the session log: it is sandboxed and opens no
  // file of its own, so it forwards a structured record to main (logging
  // conventions, "Multi-process apps"). One-way and fire-and-forget — a failure
  // to log must never become a second failure the caller has to handle.
  writeRendererLog: "log:write",
  pickDirectory: "dialog:pickDirectory",
  windowActivityChanged: "window:activityChanged",

  // The records window: opened from the main window, it reads records.sqlite3,
  // and main tells it each time a record is stored.
  openRecordsWindow: "records:open",
  readRecordsPage: "records:page",
  readRecordDetail: "records:detail",
  readRecordSources: "records:sources",
  recordsChanged: "records:changed",

  getStoragePending: "storage:pending",
  storagePendingChanged: "storage:pendingChanged",

  // UI state (state.json)
  getUiState: "state:get",
  updateUiState: "state:update",

  // App-wide settings (the storage root's config.json)
  getAppSettings: "appSettings:get",
  saveAppSettings: "appSettings:save",

  // The interface language the main process settled on, and its changes when
  // a new choice is saved.
  getInterfaceLanguage: "i18n:get",
  interfaceLanguageChanged: "i18n:changed",

  // Posts
  listPosts: "post:list",
  getPost: "post:get",
  createPost: "post:create",
  updatePost: "post:update",
  changePostStatus: "post:status",
  setPostLocked: "post:locked",
  deletePost: "post:delete",
  listReferrers: "post:referrers",
  rebuildPostIndex: "post:rebuildIndex",
  // Content streaming: renderer fires every editor change at the main process,
  // which owns coalescing and disk writes (write-behind in the post store).
  queuePostContent: "post:queueContent",
  // Metadata field edits stream the same way; the reply says whether the edit
  // was buffered or refused (a slug that is invalid or taken).
  queuePostMetadata: "post:queueMetadata",
  // Whether a post's Metadata tab shows a value the store refused. Main asks
  // before quitting or closing the window while one does. One-way.
  reportMetadataRefusal: "post:metadataRefusal",
  postContentSaved: "post:contentSaved",
  postContentSaveFailed: "post:contentSaveFailed",
  // A metadata edit held while storage was busy, which the store refused once
  // it was delivered. Its field was told it was buffered; this reports otherwise.
  postMetadataRefused: "post:metadataRefused",

  // Targets
  listTargets: "target:list",
  saveTargets: "target:save",
  renameTarget: "target:rename",

  // Settings
  getSettings: "settings:get",
  saveSettings: "settings:save",
  getConfigNotice: "settings:configNotice",

  // The Anthropic section
  getAnthropicSettings: "anthropic:get",
  saveAnthropicSettings: "anthropic:save",

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
  generateImaging: "imaging:generate",
  // Cancels any in-flight AI request (analysis, metadata, imaging) by its id.
  aiRequestAbort: "ai:request:abort",
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
  /**
   * Newer text for this post is still held in the main process, waiting for
   * storage, so this save is not the post's latest and its retrying notice stays.
   */
  newerEditHeld: boolean;
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
}

/** A held metadata edit the store refused on delivery: the edits it carried and why. */
export interface PostMetadataRefusedEvent {
  postId: string;
  edits: EditablePostMetadata;
  refusal: Message;
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

/** The two smaller renditions main makes of a still image: a grid thumbnail and a display image. */
export type ImageDerivativeKind = "thumb" | "display";

/**
 * Builds the URL of an image's thumbnail or display image. It is addressed by
 * the SHA-256 of the image's bytes, so its content never changes, and main
 * serves only hashes it has seen among the assets it listed.
 */
export function imageDerivativeUrl(kind: ImageDerivativeKind, contentHash: string): string {
  return `${ASSET_SCHEME}://${kind}/${encodeURIComponent(contentHash)}`;
}

// --- Method payload/result helpers ---

/**
 * How an upload starts: the preload posts this on `CHANNELS.uploadAsset` with
 * one end of a fresh MessageChannel, and the file's bytes follow on that port
 * (see {@link AssetUploadToMain}). The renderer is an untrusted IPC peer, so
 * main checks every field and never reads `sourcePath`'s bytes: it only takes
 * the original's times and permissions from it when its size matches the bytes
 * that arrived.
 */
export interface AssetUploadStart {
  wsId: string;
  postId: string;
  name: string;
  /** Where the picked or dropped file is on disk, so the copy keeps its metadata. */
  sourcePath?: string;
}

/**
 * The largest slice of a file one upload message carries. Main answers each
 * slice it has written with `next`, and grants {@link ASSET_UPLOAD_SLICES_IN_FLIGHT}
 * to begin with, so an upload of any size holds only a few slices in either
 * process.
 */
export const ASSET_UPLOAD_SLICE_BYTES = 4 * 1024 * 1024;
export const ASSET_UPLOAD_SLICES_IN_FLIGHT = 2;

/** Renderer to main on an upload's port: the next slice, the end of the file, or a read that failed. */
export type AssetUploadToMain =
  | { type: "slice"; data: ArrayBuffer }
  | { type: "end" }
  | { type: "abort" };

/**
 * Main to renderer on an upload's port: room for one more slice, the upload's
 * result, or a failure the renderer reports with `message`, which is fixed text
 * or a carried catalogue message, never a raw error (error-handling-conventions).
 */
export type AssetUploadFromMain =
  | { type: "next" }
  | { type: "result"; result: AssetUploadResult }
  | { type: "failed"; message: string };

/** Where each paged list section's requested page starts. */
export type PostListOffsets = Readonly<Record<PagedPostStatus, number>>;

/** Predictable upload admissions cross IPC as data, never serialized exceptions. */
export type AssetUploadAdmission =
  | { code: "reserved-name"; filename: string }
  | { code: "post-locked" }
  | { code: "post-missing" };

/**
 * Why the file's bytes did not reach the workspace, as data the renderer maps to
 * its own copy. Each leaves nothing behind: the partial copy is removed.
 * `source-unreadable`: the picked file could not be read to the end.
 * `workspace-unwritable`: the copy could not be written into the workspace
 * folder, because its disk is `full`, writing there is `denied`, or the write
 * otherwise `failed`.
 */
export type AssetUploadFailure =
  | { code: "source-unreadable" }
  | { code: "workspace-unwritable"; problem: WorkspaceWriteProblem };
export type WorkspaceWriteProblem = "full" | "denied" | "failed";

/**
 * What could not be saved after the attached file itself was added or removed;
 * the change to the file stands. "details" is the asset's upload time and image
 * details, "modifiedTime" the post's modified time.
 */
export type AssetUnsavedStep = "details" | "modifiedTime";

export type AssetUploadResult =
  | { ok: true; asset: AssetMeta; unsaved?: AssetUnsavedStep[] }
  | { ok: false; admission: AssetUploadAdmission }
  | { ok: false; failure: AssetUploadFailure };

export interface AssetDeleteResult {
  unsaved?: AssetUnsavedStep[];
}

export interface PostUpdate {
  content?: string;
  frontMatter?: EditablePostMetadata;
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
  // The model's reasoning summary, produced before the answer when the analysis role's
  // thinking is adaptive. A separate frame so the renderer can show it as reasoning rather than
  // splicing it into the analysis text.
  | { type: "thinking"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** Handle for an in-flight AI request: `done` settles with its result, and
 * `abort` cancels the paid call itself in the main process, not only the wait. */
export interface AiRequestHandle<T> {
  done: Promise<T>;
  abort: () => void;
}

/** Handle returned by `runAnalysisStream`: settles when the stream completes. */
export type AnalysisStreamHandle = AiRequestHandle<void>;

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
  getStoragePending(): Promise<boolean>;
  onStoragePendingChanged(listener: (pending: boolean) => void): () => void;
  /** The running OS, exposed synchronously from the preload (process.platform). */
  platform: Platform;
  /** Native BrowserWindow activation, which is distinct from DOM document focus on macOS. */
  onWindowActivityChanged(listener: (active: boolean) => void): () => void;

  // Workspace management
  listWorkspaces(): Promise<Workspace[]>;
  /** Creates a workspace at the exact destination, or uses the independent default when absent. */
  createWorkspace(name: string, dataDirectory?: string): Promise<Workspace>;
  /** Registers a folder that already holds a BigMouth workspace; one already listed is returned as is. */
  addExistingWorkspace(dataDirectory: string): Promise<Workspace>;
  /** The default workspace destination, independent of its name. */
  suggestWorkspaceLocation(): Promise<string>;
  /** Renames a workspace. A workspace's folder is where it is; there is no relocation. */
  updateWorkspace(id: string, updates: { name: string }): Promise<Workspace>;
  deleteWorkspace(id: string): Promise<WorkspaceDeleteResult>;
  /** Opens an allowed web or mail URL in the OS handler. */
  openExternal(url: string): Promise<void>;
  /** Native folder picker: a workspace folder to add, or the exact destination to create one at; null if cancelled. */
  pickDirectory(purpose: "workspace" | "create", initialDirectory?: string): Promise<string | null>;

  // The records window. Opening it again brings it forward.
  openRecordsWindow(): Promise<void>;
  readRecordsPage(query: RecordsQuery): Promise<RecordsPage>;
  readRecordDetail(kind: RecordKind, id: number): Promise<RecordDetail | null>;
  readRecordSources(): Promise<RecordSources>;
  /** A record was stored in the records database. */
  onRecordsChanged(listener: () => void): () => void;

  // UI state (state.json) — persisted view state: side-pane widths and the last
  // active workspace id. Its own store, separate from workspace config.
  getUiState(): Promise<UiState>;
  updateUiState(patch: Partial<UiState>): Promise<UiState>;

  // App-wide settings (the storage root's config.json) — the theme, which
  // applies in every workspace. Saving applies it to the whole app.
  getAppSettings(): Promise<AppSettingsView>;
  saveAppSettings(settings: Partial<AppSettings>): Promise<AppSettings>;

  // The interface language: what the window speaks and formats in, as the main
  // process resolved it, so the window and the native menus always agree.
  getInterfaceLanguage(): Promise<InterfaceLanguage>;
  onInterfaceLanguageChanged(listener: (language: InterfaceLanguage) => void): () => void;

  // Posts
  /** Every section: the whole of each unpaged one, and a page of `limit` posts
   *  from each paged one's offset. */
  listPosts(wsId: string, offsets: PostListOffsets, limit: number): Promise<PostListResponse>;
  getPost(wsId: string, id: string): Promise<Post>;
  createPost(wsId: string, target: string, language: string, sourceId?: string): Promise<Post>;
  updatePost(wsId: string, id: string, updates: PostUpdate): Promise<PostMutationResult>;
  /** Fire-and-forget: buffer a content edit in the main process, which owns the
   *  debounce, the disk write, and the flush at quit. Post ids are unique
   *  nanoids, so saved/failed events are matched by post id alone. */
  queuePostContent(wsId: string, id: string, content: string): void;
  /** Resolves null when the edit was buffered, else the reason it was refused. */
  queuePostMetadata(wsId: string, id: string, edits: EditablePostMetadata): Promise<Message | null>;
  /** Fire-and-forget: whether this post's Metadata tab shows a refused value. */
  reportMetadataRefusal(id: string, refused: boolean): void;
  onPostContentSaved(listener: (event: PostContentSavedEvent) => void): () => void;
  onPostContentSaveFailed(listener: (event: PostContentSaveFailedEvent) => void): () => void;
  onPostMetadataRefused(listener: (event: PostMetadataRefusedEvent) => void): () => void;
  changePostStatus(wsId: string, id: string, status: PostStatus): Promise<PostMutationResult>;
  setPostLocked(wsId: string, id: string, locked: boolean): Promise<PostMutationResult>;
  deletePost(wsId: string, id: string): Promise<PostDeleteResult>;
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
  renameTarget(wsId: string, oldName: string, newName: string): Promise<TargetRenameResult>;

  // Settings
  getSettings(wsId: string): Promise<Settings>;
  saveSettings(wsId: string, settings: Partial<Settings>): Promise<Settings>;
  /** Null, or why some stored settings are not in use; the file keeps them. */
  getConfigNotice(wsId: string): Promise<Message | null>;

  // The Anthropic section
  getAnthropicSettings(wsId: string): Promise<AnthropicSettingsView>;
  saveAnthropicSettings(wsId: string, input: AnthropicSettingsInput): Promise<AnthropicSettingsView>;

  // Generation prompts
  getGenerationPrompts(wsId: string): Promise<GenerationPromptsData>;
  getGenerationPromptDefaults(wsId: string): Promise<GenerationPromptsData>;
  saveGenerationPrompts(wsId: string, data: GenerationPromptsData): Promise<GenerationPromptsData>;

  // Analysis prompts
  listAnalysisPrompts(wsId: string): Promise<AnalysisPrompt[]>;
  listAnalysisPromptDefaults(wsId: string): Promise<AnalysisPrompt[]>;
  saveAnalysisPrompts(wsId: string, prompts: AnalysisPrompt[]): Promise<AnalysisPrompt[]>;

  // Assets
  listAssets(wsId: string, postId: string): Promise<AssetListing>;
  /** Streams `file` to main and settles with the upload's result; see {@link AssetUploadStart}. */
  uploadAsset(wsId: string, postId: string, file: File): Promise<AssetUploadResult>;
  deleteAsset(wsId: string, postId: string, filename: string): Promise<AssetDeleteResult>;

  // AI generation
  generateMetadata(
    wsId: string,
    postId: string,
    fields: string[],
    content: string,
  ): AiRequestHandle<MetadataGenerationResults>;
  runAnalysisStream(
    params: AnalysisStreamParams,
    onDelta: (delta: string) => void,
    onThinking?: (delta: string) => void,
  ): AnalysisStreamHandle;
  generateImaging(wsId: string, postId: string, content: string, options: ImagingOptions): AiRequestHandle<string[]>;
}
