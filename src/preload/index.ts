import { contextBridge, ipcRenderer } from "electron";

import {
  type PostContentSavedEvent,
  type PostContentSaveFailedEvent,
  CHANNELS,
  analysisStreamChannel,
  type AiConfigInput,
  type AiConfigPatch,
  type AiRequestHandle,
  type AnalysisStreamFrame,
  type AnalysisStreamHandle,
  type AnalysisStreamParams,
  type AssetUploadInput,
  type AssetUploadResult,
  type BigMouthApi,
  type MetadataGenerationResults,
  type PostUpdate,
  type RendererLogEntry,
  type TargetRenameResult,
} from "@shared/ipc";
import type {
  AiConfigsData,
  AnalysisPrompt,
  AppSettings,
  AppSettingsLoad,
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
  UiState,
  Workspace,
} from "@shared/types";
import type { InterfaceLanguage } from "@shared/i18n/languages";

// Per-window counter for AI request ids. Generated renderer-side so the renderer
// can subscribe to a stream's channel, or send an abort, before the request
// settles. The main process keys requests by window as well as by id, so two
// windows counting from 1 never reach each other's calls.
let nextRequestId = 1;

function sendAiAbort(requestId: string): void {
  ipcRenderer.send(CHANNELS.aiRequestAbort, requestId);
}

/**
 * Starts an invoke-based AI request whose paid call the caller can cancel. The
 * abort may be sent at once: the main handler registers the request before it
 * first awaits, and this window's messages arrive in order (see aiRequests.ts).
 */
function startAiRequest<T>(channel: string, ...args: unknown[]): AiRequestHandle<T> {
  const requestId = `ai-${nextRequestId++}`;
  let settled = false;
  const done = (ipcRenderer.invoke(channel, requestId, ...args) as Promise<T>).finally(() => {
    settled = true;
  });
  return {
    done,
    abort: () => {
      if (!settled) sendAiAbort(requestId);
    },
  };
}

// The bridge the renderer talks to over IPC. Each method forwards to an ipcMain
// handler by channel; the analysis stream subscribes to a per-request event
// channel and reassembles the delta/done/error frames behind a single Promise.
// Implemented via `satisfies` (tsconfig-env-split-conventions) so the shared
// contract is enforced without leaking a preload type back to the renderer.
const api = {
  // The running OS, read synchronously here in the Node-capable preload so the
  // renderer can resolve the platform without an IPC round-trip.
  platform: process.platform,
  onWindowActivityChanged: (listener: (active: boolean) => void) => {
    const wrapped = (_event: unknown, active: boolean): void => {
      if (typeof active === "boolean") listener(active);
    };
    ipcRenderer.on(CHANNELS.windowActivityChanged, wrapped);
    return () => ipcRenderer.removeListener(CHANNELS.windowActivityChanged, wrapped);
  },

  // --- Workspace management ---
  listWorkspaces: () => ipcRenderer.invoke(CHANNELS.listWorkspaces) as Promise<Workspace[]>,
  openOrCreateWorkspace: (name?: string, dataDirectory?: string) =>
    ipcRenderer.invoke(CHANNELS.openOrCreateWorkspace, name, dataDirectory) as Promise<Workspace>,
  updateWorkspace: (id: string, updates: { name: string }) =>
    ipcRenderer.invoke(CHANNELS.updateWorkspace, id, updates) as Promise<Workspace>,
  deleteWorkspace: (id: string) => ipcRenderer.invoke(CHANNELS.deleteWorkspace, id) as Promise<void>,
  revealCurrentLogFile: () => ipcRenderer.invoke(CHANNELS.revealCurrentLogFile) as Promise<string>,
  openExternal: (url: string) => ipcRenderer.invoke(CHANNELS.openExternal, url) as Promise<void>,
  // `send`, not `invoke`: a log write is fire-and-forget, so a failure to record
  // something can never turn into a second failure the caller has to handle.
  writeRendererLog: (entry: RendererLogEntry) => ipcRenderer.send(CHANNELS.writeRendererLog, entry),
  pickDirectory: () => ipcRenderer.invoke(CHANNELS.pickDirectory) as Promise<string | null>,

  // --- UI state (state.json) ---
  getUiState: () => ipcRenderer.invoke(CHANNELS.getUiState) as Promise<UiState>,
  updateUiState: (patch: Partial<UiState>) =>
    ipcRenderer.invoke(CHANNELS.updateUiState, patch) as Promise<UiState>,

  // --- App settings ---
  getAppSettings: () => ipcRenderer.invoke(CHANNELS.getAppSettings) as Promise<AppSettingsLoad>,
  saveAppSettings: (settings: AppSettings) =>
    ipcRenderer.invoke(CHANNELS.saveAppSettings, settings) as Promise<AppSettings>,
  getInterfaceLanguage: () => ipcRenderer.invoke(CHANNELS.getInterfaceLanguage) as Promise<InterfaceLanguage>,
  onInterfaceLanguageChanged: (listener: (language: InterfaceLanguage) => void) => {
    const wrapped = (_event: unknown, language: InterfaceLanguage): void => listener(language);
    ipcRenderer.on(CHANNELS.interfaceLanguageChanged, wrapped);
    return () => ipcRenderer.removeListener(CHANNELS.interfaceLanguageChanged, wrapped);
  },

  // --- Posts ---
  listPosts: (wsId: string, publishedOffset: number, limit: number, expiredOffset: number) =>
    ipcRenderer.invoke(CHANNELS.listPosts, wsId, publishedOffset, limit, expiredOffset) as Promise<PostListResponse>,
  getPost: (wsId: string, id: string) => ipcRenderer.invoke(CHANNELS.getPost, wsId, id) as Promise<Post>,
  createPost: (wsId: string, target: string, language: string, sourceId?: string) =>
    ipcRenderer.invoke(CHANNELS.createPost, wsId, target, language, sourceId) as Promise<Post>,
  updatePost: (wsId: string, id: string, updates: PostUpdate) =>
    ipcRenderer.invoke(CHANNELS.updatePost, wsId, id, updates) as Promise<PostMutationResult>,
  changePostStatus: (wsId: string, id: string, status: PostStatus) =>
    ipcRenderer.invoke(CHANNELS.changePostStatus, wsId, id, status) as Promise<PostMutationResult>,
  deletePost: (wsId: string, id: string) => ipcRenderer.invoke(CHANNELS.deletePost, wsId, id) as Promise<void>,
  listReferrers: (wsId: string, id: string) =>
    ipcRenderer.invoke(CHANNELS.listReferrers, wsId, id) as Promise<{ count: number; ids: string[] }>,
  rebuildPostIndex: (wsId: string) =>
    ipcRenderer.invoke(CHANNELS.rebuildPostIndex, wsId) as Promise<{
      count: number;
      skipped: number;
      duplicateSlugs: number;
      orphanedAssets: number;
    }>,
  // Content streaming: fire-and-forget send; the main-process post store owns
  // the debounce, the disk write, and the flush at quit.
  queuePostContent: (wsId: string, id: string, content: string) => {
    ipcRenderer.send(CHANNELS.queuePostContent, wsId, id, content);
  },
  queuePostMetadata: (wsId: string, id: string, edits: EditablePostMetadata) =>
    ipcRenderer.invoke(CHANNELS.queuePostMetadata, wsId, id, edits) as Promise<string | null>,
  reportMetadataRefusal: (id: string, refused: boolean) =>
    ipcRenderer.send(CHANNELS.reportMetadataRefusal, id, refused),
  onPostContentSaved: (listener: (event: PostContentSavedEvent) => void) => {
    const wrapped = (_event: unknown, payload: PostContentSavedEvent): void => listener(payload);
    ipcRenderer.on(CHANNELS.postContentSaved, wrapped);
    return () => ipcRenderer.removeListener(CHANNELS.postContentSaved, wrapped);
  },
  onPostContentSaveFailed: (listener: (event: PostContentSaveFailedEvent) => void) => {
    const wrapped = (_event: unknown, payload: PostContentSaveFailedEvent): void => listener(payload);
    ipcRenderer.on(CHANNELS.postContentSaveFailed, wrapped);
    return () => ipcRenderer.removeListener(CHANNELS.postContentSaveFailed, wrapped);
  },

  // --- Targets ---
  listTargets: (wsId: string) => ipcRenderer.invoke(CHANNELS.listTargets, wsId) as Promise<Target[]>,
  saveTargets: (wsId: string, targets: Target[]) =>
    ipcRenderer.invoke(CHANNELS.saveTargets, wsId, targets) as Promise<Target[]>,
  renameTarget: (wsId: string, oldName: string, newName: string) =>
    ipcRenderer.invoke(CHANNELS.renameTarget, wsId, oldName, newName) as Promise<TargetRenameResult>,

  // --- Settings ---
  getSettings: (wsId: string) => ipcRenderer.invoke(CHANNELS.getSettings, wsId) as Promise<Settings>,
  saveSettings: (wsId: string, settings: Settings) =>
    ipcRenderer.invoke(CHANNELS.saveSettings, wsId, settings) as Promise<Settings>,

  // --- AI configs ---
  listAiConfigs: (wsId: string) => ipcRenderer.invoke(CHANNELS.listAiConfigs, wsId) as Promise<AiConfigsData>,
  createAiConfig: (wsId: string, input: AiConfigInput) =>
    ipcRenderer.invoke(CHANNELS.createAiConfig, wsId, input) as Promise<AiConfigsData>,
  updateAiConfig: (wsId: string, id: string, patch: AiConfigPatch) =>
    ipcRenderer.invoke(CHANNELS.updateAiConfig, wsId, id, patch) as Promise<AiConfigsData>,
  deleteAiConfig: (wsId: string, id: string) =>
    ipcRenderer.invoke(CHANNELS.deleteAiConfig, wsId, id) as Promise<AiConfigsData>,
  setActiveAiConfig: (wsId: string, id: string) =>
    ipcRenderer.invoke(CHANNELS.setActiveAiConfig, wsId, id) as Promise<AiConfigsData>,

  // --- Generation prompts ---
  getGenerationPrompts: (wsId: string) =>
    ipcRenderer.invoke(CHANNELS.getGenerationPrompts, wsId) as Promise<GenerationPromptsData>,
  getGenerationPromptDefaults: (wsId: string) =>
    ipcRenderer.invoke(CHANNELS.getGenerationPromptDefaults, wsId) as Promise<GenerationPromptsData>,
  saveGenerationPrompts: (wsId: string, data: GenerationPromptsData) =>
    ipcRenderer.invoke(CHANNELS.saveGenerationPrompts, wsId, data) as Promise<GenerationPromptsData>,

  // --- Analysis prompts ---
  listAnalysisPrompts: (wsId: string) =>
    ipcRenderer.invoke(CHANNELS.listAnalysisPrompts, wsId) as Promise<AnalysisPrompt[]>,
  listAnalysisPromptDefaults: (wsId: string) =>
    ipcRenderer.invoke(CHANNELS.listAnalysisPromptDefaults, wsId) as Promise<AnalysisPrompt[]>,
  saveAnalysisPrompts: (wsId: string, prompts: AnalysisPrompt[]) =>
    ipcRenderer.invoke(CHANNELS.saveAnalysisPrompts, wsId, prompts) as Promise<AnalysisPrompt[]>,

  // --- Assets ---
  listAssets: (wsId: string, postId: string) =>
    ipcRenderer.invoke(CHANNELS.listAssets, wsId, postId) as Promise<AssetMeta[]>,
  uploadAsset: (wsId: string, postId: string, file: AssetUploadInput) =>
    ipcRenderer.invoke(CHANNELS.uploadAsset, wsId, postId, file) as Promise<AssetUploadResult>,
  deleteAsset: (wsId: string, postId: string, filename: string) =>
    ipcRenderer.invoke(CHANNELS.deleteAsset, wsId, postId, filename) as Promise<void>,

  // --- AI generation ---
  generateMetadata: (wsId: string, postId: string, fields: string[], content: string) =>
    startAiRequest<MetadataGenerationResults>(CHANNELS.generateMetadata, wsId, postId, fields, content),
  runAnalysisStream: (
    params: AnalysisStreamParams,
    onDelta: (delta: string) => void,
    onThinking?: (delta: string) => void,
  ): AnalysisStreamHandle => {
    const requestId = `ai-${nextRequestId++}`;
    const channel = analysisStreamChannel(requestId);
    let settled = false;
    let started = false;
    let abortRequested = false;
    let resolveDone!: () => void;
    let rejectDone!: (err: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      ipcRenderer.removeListener(channel, listener);
      settle();
    };
    function listener(_event: unknown, frame: AnalysisStreamFrame): void {
      if (frame.type === "delta") onDelta(frame.text);
      else if (frame.type === "thinking") onThinking?.(frame.text);
      else if (frame.type === "done") finish(resolveDone);
      else if (frame.type === "error") finish(() => rejectDone(new Error(frame.message)));
    }
    // Subscribe before starting so an early frame is never missed.
    ipcRenderer.on(channel, listener);

    const sendAbort = (): void => sendAiAbort(requestId);

    void (ipcRenderer.invoke(CHANNELS.analysisStreamStart, requestId, params) as Promise<void>)
      .then(() => {
        started = true;
        // If the caller aborted before the stream was registered, deliver the
        // abort now — after registration, never before, so it cannot reach the
        // main process ahead of the stream it is meant to cancel.
        if (abortRequested) sendAbort();
      })
      .catch((err: unknown) => {
        // Pre-stream failure (validation / provider init): no frames will arrive.
        finish(() => rejectDone(err instanceof Error ? err : new Error(String(err))));
      });

    const abort = (): void => {
      if (settled) return;
      abortRequested = true;
      // Once the stream is registered, cancel it immediately; otherwise the start
      // resolution above sends the abort as soon as registration completes.
      if (started) sendAbort();
      finish(() => rejectDone(new Error("Analysis aborted")));
    };

    return { done, abort };
  },
  generateImaging: (wsId: string, postId: string, content: string, options: ImagingOptions) =>
    startAiRequest<string[]>(CHANNELS.generateImaging, wsId, postId, content, options),
} satisfies BigMouthApi;

contextBridge.exposeInMainWorld("bigmouth", api);
