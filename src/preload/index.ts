import { contextBridge, ipcRenderer } from "electron";

import {
  CHANNELS,
  analysisStreamChannel,
  type AiConfigInput,
  type AiConfigPatch,
  type AnalysisStreamFrame,
  type AnalysisStreamHandle,
  type AnalysisStreamParams,
  type AssetUploadInput,
  type BigMouthApi,
  type MetadataGenerationResults,
  type PostUpdate,
} from "@shared/ipc";
import type {
  AiConfigsData,
  AnalysisPrompt,
  AssetMeta,
  GenerationPromptsData,
  ImagingOptions,
  Post,
  PostListResponse,
  PostMutationResult,
  PostStatus,
  Settings,
  Target,
  Workspace,
} from "@shared/types";

// The bridge the renderer talks to instead of HTTP. Each method forwards to an
// ipcMain handler (Phase 3) by channel; the analysis stream subscribes to a
// per-request event channel and reassembles the old NDJSON done/error framing
// behind a single Promise. Implemented via `satisfies` (tsconfig-env-split-
// conventions) so the shared contract is enforced without leaking a preload type
// back to the renderer.
const api = {
  // --- Workspace management ---
  listWorkspaces: () => ipcRenderer.invoke(CHANNELS.listWorkspaces) as Promise<Workspace[]>,
  openOrCreateWorkspace: (name?: string, dataDirectory?: string) =>
    ipcRenderer.invoke(CHANNELS.openOrCreateWorkspace, name, dataDirectory) as Promise<Workspace>,
  updateWorkspace: (id: string, updates: { name?: string; dataDirectory?: string }) =>
    ipcRenderer.invoke(CHANNELS.updateWorkspace, id, updates) as Promise<Workspace>,
  deleteWorkspace: (id: string) => ipcRenderer.invoke(CHANNELS.deleteWorkspace, id) as Promise<void>,
  revealCurrentLogFile: () => ipcRenderer.invoke(CHANNELS.revealCurrentLogFile) as Promise<string>,

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
    ipcRenderer.invoke(CHANNELS.rebuildPostIndex, wsId) as Promise<{ count: number }>,

  // --- Targets ---
  listTargets: (wsId: string) => ipcRenderer.invoke(CHANNELS.listTargets, wsId) as Promise<Target[]>,
  saveTargets: (wsId: string, targets: Target[]) =>
    ipcRenderer.invoke(CHANNELS.saveTargets, wsId, targets) as Promise<Target[]>,
  renameTarget: (wsId: string, oldName: string, newName: string) =>
    ipcRenderer.invoke(CHANNELS.renameTarget, wsId, oldName, newName) as Promise<{
      targets: Target[];
      postsUpdated: number;
    }>,

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
    ipcRenderer.invoke(CHANNELS.uploadAsset, wsId, postId, file) as Promise<AssetMeta>,
  deleteAsset: (wsId: string, postId: string, filename: string) =>
    ipcRenderer.invoke(CHANNELS.deleteAsset, wsId, postId, filename) as Promise<void>,

  // --- AI generation ---
  generateMetadata: (wsId: string, postId: string, fields: string[], content: string) =>
    ipcRenderer.invoke(CHANNELS.generateMetadata, wsId, postId, fields, content) as Promise<MetadataGenerationResults>,
  runAnalysis: (wsId: string, postId: string, promptName: string, content: string) =>
    ipcRenderer.invoke(CHANNELS.runAnalysis, wsId, postId, promptName, content) as Promise<string>,
  runAnalysisStream: (params: AnalysisStreamParams, onDelta: (delta: string) => void): AnalysisStreamHandle => {
    let requestId: string | null = null;
    let settled = false;
    let resolveDone!: () => void;
    let rejectDone!: (err: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    void (ipcRenderer.invoke(CHANNELS.analysisStreamStart, params) as Promise<string>)
      .then((id) => {
        if (settled) {
          // Aborted before the stream started; tell main to drop it.
          ipcRenderer.send(CHANNELS.analysisStreamAbort, id);
          return;
        }
        requestId = id;
        const channel = analysisStreamChannel(id);
        const finish = (settle: () => void): void => {
          if (settled) return;
          settled = true;
          ipcRenderer.removeListener(channel, listener);
          settle();
        };
        function listener(_event: unknown, frame: AnalysisStreamFrame): void {
          if (frame.type === "delta") onDelta(frame.text);
          else if (frame.type === "done") finish(resolveDone);
          else if (frame.type === "error") finish(() => rejectDone(new Error(frame.message)));
        }
        ipcRenderer.on(channel, listener);
      })
      .catch((err: unknown) => {
        if (settled) return;
        settled = true;
        rejectDone(err instanceof Error ? err : new Error(String(err)));
      });

    const abort = (): void => {
      if (settled) return;
      settled = true;
      if (requestId !== null) ipcRenderer.send(CHANNELS.analysisStreamAbort, requestId);
      rejectDone(new Error("Analysis aborted"));
    };

    return { done, abort };
  },
  generateImaging: (wsId: string, postId: string, content: string, options: ImagingOptions) =>
    ipcRenderer.invoke(CHANNELS.generateImaging, wsId, postId, content, options) as Promise<string[]>,
} satisfies BigMouthApi;

contextBridge.exposeInMainWorld("bigmouth", api);
