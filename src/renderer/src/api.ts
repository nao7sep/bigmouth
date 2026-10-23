import type {
  AppSettings,
  AppSettingsView,
  Post,
  PostDeleteResult,
  PostStatus,
  PostMutationResult,
  PostListResponse,
  AnalysisPrompt,
  Settings,
  Target,
  AssetListing,
  AssetMeta,
  AnthropicSettingsInput,
  AnthropicSettingsView,
  EditablePostMetadata,
  GenerationPromptsData,
  ImagingOptions,
  UiState,
  Workspace,
  WorkspaceConfigView,
  WorkspaceDeleteResult,
  ImagingRelation,
  ImagingMood,
  ImagingLiteralness,
  ImagingPeople,
  ImagingStyle,
} from "@shared/types";
import {
  type AssetDeleteResult,
  type AssetUnsavedStep,
  type AssetUploadAdmission,
  type AssetUploadFailure,
  type PostContentSavedEvent,
  type PostContentSaveFailedEvent,
  type PostMetadataRefusedEvent,
  assetUrl as buildAssetUrl,
  imageDerivativeUrl,
  type ImageDerivativeKind,
  type AiRequestHandle,
  type MetadataGenerationResults,
  type PostListOffsets,
  type PostUpdate,
  type TargetRenameResult,
} from "@shared/ipc";
import { AssetUploadAdmissionError, AssetUploadFailureError } from "./util/assetUpload";
import { FIRST_PAGES } from "@shared/postStatus";
import { message, type Message } from "@shared/i18n/translate";
import type { RecordDetail, RecordKind, RecordSources, RecordsPage, RecordsQuery } from "@shared/records";

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

export function createWorkspace(name: string, dataDirectory?: string): Promise<Workspace> {
  return bridge().createWorkspace(name, dataDirectory);
}

export function addExistingWorkspace(dataDirectory: string): Promise<Workspace> {
  return bridge().addExistingWorkspace(dataDirectory);
}

/** Proposes the default workspace destination independently of its name, without creating it. */
export function suggestWorkspaceLocation(): Promise<string> {
  return bridge().suggestWorkspaceLocation();
}

export function updateWorkspace(id: string, updates: { name: string }): Promise<Workspace> {
  return bridge().updateWorkspace(id, updates);
}

export function deleteWorkspace(id: string): Promise<WorkspaceDeleteResult> {
  return bridge().deleteWorkspace(id);
}

// --- The records window (no workspace context) ---

export function openRecordsWindow(): Promise<void> {
  return bridge().openRecordsWindow();
}

export function readRecordsPage(query: RecordsQuery): Promise<RecordsPage> {
  return bridge().readRecordsPage(query);
}

export function readRecordDetail(kind: RecordKind, id: number): Promise<RecordDetail | null> {
  return bridge().readRecordDetail(kind, id);
}

export function readRecordSources(): Promise<RecordSources> {
  return bridge().readRecordSources();
}

export function onRecordsChanged(listener: () => void): () => void {
  return bridge().onRecordsChanged(listener);
}

export function openExternal(url: string): Promise<void> {
  return bridge().openExternal(url);
}

export function pickWorkspaceDirectory(purpose: "workspace" | "create", initialDirectory?: string): Promise<string | null> {
  return bridge().pickDirectory(purpose, initialDirectory);
}

/** A started user mutation exceeded its normal wait and still owns its result. */
export function getStoragePending(): Promise<boolean> { return bridge().getStoragePending(); }
export function onStoragePendingChanged(listener: (pending: boolean) => void): () => void {
  return bridge().onStoragePendingChanged(listener);
}

// --- UI state (state.json) ---

/** The persisted view state: side-pane intent widths + last active workspace id. */
export function getUiState(): Promise<UiState> {
  return bridge().getUiState();
}

/** Persist a partial UI-state change (a pane drag, or the active workspace id). */
export function updateUiState(patch: Partial<UiState>): Promise<UiState> {
  return bridge().updateUiState(patch);
}

// --- App settings (the storage root's config.json) ---

/** The app-wide settings, and where an unreadable file was moved this launch. */
export function getAppSettings(): Promise<AppSettingsView> {
  return bridge().getAppSettings();
}

/** Saves the app-wide settings; the main process applies the theme to the app. */
export function saveAppSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
  return bridge().saveAppSettings(settings);
}

// --- Posts ---

export function listPosts(offsets: PostListOffsets = FIRST_PAGES, limit = 50, workspaceId?: string): Promise<PostListResponse> {
  return bridge().listPosts(requireWs(workspaceId), offsets, limit);
}

export function getPost(id: string, workspaceId?: string): Promise<Post> {
  return bridge().getPost(requireWs(workspaceId), id);
}

export function createPost(target: string, language: string, sourceId?: string, workspaceId?: string): Promise<Post> {
  return bridge().createPost(requireWs(workspaceId), target, language, sourceId);
}

export function queuePostContent(id: string, content: string, workspaceId?: string): void {
  bridge().queuePostContent(requireWs(workspaceId), id, content);
}

/**
 * Buffers metadata field edits on the storage worker, which owns the write and
 * the flush at quit. Resolves null when buffered, else why the edit was refused.
 */
export function queuePostMetadata(
  id: string,
  edits: EditablePostMetadata,
  workspaceId?: string,
): Promise<Message | null> {
  return bridge().queuePostMetadata(requireWs(workspaceId), id, edits);
}

/** Tells main whether this post's Metadata tab shows a value the store refused. */
export function reportMetadataRefusal(id: string, refused: boolean): void {
  bridge().reportMetadataRefusal(id, refused);
}

export function onPostContentSaved(
  listener: (event: PostContentSavedEvent) => void,
): () => void {
  const workspaceId = requireWs();
  return bridge().onPostContentSaved((event) => {
    if (event.wsId === workspaceId) listener(event);
  });
}

/** Calls `listener` each time this window comes back to the front. */
export function onWindowActivated(listener: () => void): () => void {
  return bridge().onWindowActivityChanged((active) => {
    if (active) listener();
  });
}

export function onPostContentSaveFailed(
  listener: (event: PostContentSaveFailedEvent) => void,
): () => void {
  const workspaceId = requireWs();
  return bridge().onPostContentSaveFailed((event) => {
    if (event.wsId === workspaceId) listener(event);
  });
}

/** A held metadata edit the store refused once storage took it. */
export function onPostMetadataRefused(
  listener: (event: PostMetadataRefusedEvent) => void,
): () => void {
  const workspaceId = requireWs();
  return bridge().onPostMetadataRefused((event) => {
    if (event.wsId === workspaceId) listener(event);
  });
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

export function setPostLocked(
  id: string,
  locked: boolean,
  workspaceId?: string,
): Promise<PostMutationResult> {
  return bridge().setPostLocked(requireWs(workspaceId), id, locked);
}

export function deletePost(id: string, workspaceId?: string): Promise<PostDeleteResult> {
  return bridge().deletePost(requireWs(workspaceId), id);
}

export function listReferrers(
  id: string,
  workspaceId?: string,
): Promise<{ count: number; ids: string[] }> {
  return bridge().listReferrers(requireWs(workspaceId), id);
}

export function rebuildPostIndex(workspaceId?: string): Promise<{
  count: number;
  skipped: number;
  duplicateSlugs: number;
  orphanedAssets: number;
}> {
  return bridge().rebuildPostIndex(requireWs(workspaceId));
}

// --- Targets ---

export function listTargets(workspaceId?: string, forEditing?: boolean): Promise<Target[]> {
  return bridge().listTargets(requireWs(workspaceId), forEditing);
}

export function saveTargets(targets: Target[], workspaceId?: string): Promise<Target[]> {
  return bridge().saveTargets(requireWs(workspaceId), targets);
}

export function renameTarget(
  oldName: string,
  newName: string,
  workspaceId?: string,
): Promise<TargetRenameResult> {
  return bridge().renameTarget(requireWs(workspaceId), oldName, newName);
}

// --- Settings ---

export function getSettings(workspaceId?: string): Promise<Settings> {
  return bridge().getSettings(requireWs(workspaceId));
}

export function saveSettings(settings: Partial<Settings>, workspaceId?: string): Promise<Settings> {
  return bridge().saveSettings(requireWs(workspaceId), settings);
}

/** Null, or why some of the workspace's stored settings are not in use. */
export function getConfigNotice(workspaceId?: string): Promise<Message | null> {
  return bridge().getConfigNotice(requireWs(workspaceId));
}

// --- The Anthropic section ---

export function getAnthropicSettings(workspaceId?: string): Promise<AnthropicSettingsView> {
  return bridge().getAnthropicSettings(requireWs(workspaceId));
}

/** A blank or omitted `apiKey` keeps the stored key. */
export function saveAnthropicSettings(
  input: AnthropicSettingsInput,
  workspaceId?: string,
): Promise<AnthropicSettingsView> {
  return bridge().saveAnthropicSettings(requireWs(workspaceId), input);
}

// --- Generation prompts ---

export function getGenerationPrompts(workspaceId?: string): Promise<GenerationPromptsData> {
  return bridge().getGenerationPrompts(requireWs(workspaceId));
}

export function getGenerationPromptDefaults(workspaceId?: string): Promise<GenerationPromptsData> {
  return bridge().getGenerationPromptDefaults(requireWs(workspaceId));
}

export function saveGenerationPrompts(data: GenerationPromptsData, workspaceId?: string): Promise<GenerationPromptsData> {
  return bridge().saveGenerationPrompts(requireWs(workspaceId), data);
}

// --- Analysis prompts ---

export function listAnalysisPrompts(workspaceId?: string, forEditing?: boolean): Promise<AnalysisPrompt[]> {
  return bridge().listAnalysisPrompts(requireWs(workspaceId), forEditing);
}

export function listAnalysisPromptDefaults(workspaceId?: string): Promise<AnalysisPrompt[]> {
  return bridge().listAnalysisPromptDefaults(requireWs(workspaceId));
}

export function saveAnalysisPrompts(prompts: AnalysisPrompt[], workspaceId?: string): Promise<AnalysisPrompt[]> {
  return bridge().saveAnalysisPrompts(requireWs(workspaceId), prompts);
}

// --- Assets ---

export function listAssets(postId: string, workspaceId?: string): Promise<AssetListing> {
  return bridge().listAssets(requireWs(workspaceId), postId);
}

/** An added asset, and what could not be saved after the file itself was added. */
export interface UploadedAsset {
  asset: AssetMeta;
  unsaved?: AssetUnsavedStep[];
}

/**
 * Adds `file` to a post. The bridge streams the file to the main process, so
 * nothing here reads it whole; a refusal throws AssetUploadAdmissionError and a
 * file that could not be read or written throws AssetUploadFailureError, each
 * with the reason to show.
 */
export async function uploadAsset(postId: string, file: File, workspaceId?: string): Promise<UploadedAsset> {
  const result = await bridge().uploadAsset(requireWs(workspaceId), postId, file);
  if (result.ok) return result.unsaved ? { asset: result.asset, unsaved: result.unsaved } : { asset: result.asset };
  if ("failure" in result) throw new AssetUploadFailureError(assetUploadFailureMessage(result.failure));
  throw new AssetUploadAdmissionError(assetUploadAdmissionMessage(result.admission));
}

function assetUploadAdmissionMessage(admission: AssetUploadAdmission): Message {
  switch (admission.code) {
    case "reserved-name":
      return message("assets.admissionReserved", { name: admission.filename });
    case "post-locked":
      return message("assets.admissionLocked");
    case "post-missing":
      return message("assets.admissionPostMissing");
  }
}

function assetUploadFailureMessage(failure: AssetUploadFailure): Message {
  if (failure.code === "source-unreadable") return message("assets.sourceUnreadable");
  switch (failure.problem) {
    case "full":
      return message("assets.workspaceFull");
    case "denied":
      return message("assets.workspaceDenied");
    case "failed":
      return message("assets.workspaceWriteFailed");
  }
}

export function deleteAsset(postId: string, filename: string, workspaceId?: string): Promise<AssetDeleteResult> {
  return bridge().deleteAsset(requireWs(workspaceId), postId, filename);
}

// --- AI generation ---

/**
 * Settles with an AI request, and cancels its paid call in the main process when
 * `signal` aborts — rejecting with an AbortError at once, so the caller never
 * waits on work it has abandoned.
 */
function settleOrCancel<T>(handle: AiRequestHandle<T>, signal: AbortSignal | undefined, what: string): Promise<T> {
  if (!signal) return handle.done;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      handle.abort();
      reject(new DOMException(`${what} aborted`, "AbortError"));
    };
    if (signal.aborted) {
      onAbort();
      handle.done.catch(() => {});
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    handle.done.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export async function generateMetadataField(
  postId: string,
  field: string,
  content: string,
  signal?: AbortSignal,
): Promise<string> {
  const results = await generateMetadataFields(postId, [field], content, signal);
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
  signal?: AbortSignal,
): Promise<MetadataGenerationResults> {
  return settleOrCancel(bridge().generateMetadata(requireWs(), postId, fields, content), signal, "Metadata generation");
}

export function runAnalysisStream(
  postId: string,
  promptName: string,
  content: string,
  options: {
    signal?: AbortSignal;
    onChunk: (delta: string) => void;
    /** Reasoning summary, streamed only when the analysis role's thinking is adaptive. */
    onThinking?: (delta: string) => void;
  },
): Promise<void> {
  const handle = bridge().runAnalysisStream(
    { wsId: requireWs(), postId, promptName, content },
    options.onChunk,
    options.onThinking,
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
  return settleOrCancel(bridge().generateImaging(requireWs(), postId, content, options), signal, "Imaging");
}

/** The URL for serving a raw asset file through the custom protocol. */
export function assetUrl(postId: string, filename: string, workspaceId?: string): string {
  return buildAssetUrl(requireWs(workspaceId), postId, filename);
}

/** The URL of an image's thumbnail or display image, addressed by its content hash. */
export function assetDerivativeUrl(kind: ImageDerivativeKind, contentHash: string): string {
  return imageDerivativeUrl(kind, contentHash);
}

// --- Diagnostics ---

/**
 * Records a renderer-side failure in the session log.
 *
 * The renderer is sandboxed and writes no records, so without this everything
 * it recovers from would leave no trace anywhere — a failed `listReferrers`
 * silently downgrades a delete confirmation from naming the posts that would be
 * unlinked to a bare "cannot be undone", and a user reporting it would leave
 * nothing to reconstruct.
 *
 * Never throws: a failure to record something must not become a second failure
 * the caller has to handle. That is also why it is a `send`, not an `invoke`.
 */
export function reportProblem(
  message: string,
  err?: unknown,
  detail?: Record<string, unknown>,
): void {
  const diagnostic = { ...(detail ?? {}), ...describeError(err) };
  try {
    bridge().writeRendererLog({
      level: "error",
      message,
      detail: diagnostic,
    });
  } catch (reportError) {
    console.error("[BigMouth] Renderer diagnostic could not be recorded.", { reportError, message, diagnostic });
  }
}

function describeError(err: unknown, seen = new WeakSet<object>()): Record<string, unknown> {
  if (err === undefined) return {};
  if (err instanceof Error) {
    if (seen.has(err)) return { error: { name: err.name, message: err.message, cause: "circular" } };
    seen.add(err);
    return {
      error: {
        name: err.name,
        message: err.message,
        stack: err.stack,
        ...(err.cause === undefined ? {} : { cause: describeError(err.cause, seen).error }),
      },
    };
  }
  return { error: String(err) };
}

export function getWorkspaceConfig(workspaceId?: string): Promise<WorkspaceConfigView> {
  return bridge().getWorkspaceConfig(requireWs(workspaceId));
}
