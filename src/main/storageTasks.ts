import fs from "node:fs";
import path from "node:path";
import * as workspaceStore from "./core/services/workspaceStore.js";
import * as configStore from "./core/services/configStore.js";
import * as postStore from "./core/services/postStore.js";
import * as assetStore from "./core/services/assetStore.js";
import * as stateStore from "./core/services/stateStore.js";
import * as appSettingsStore from "./core/services/appSettingsStore.js";
import * as recordsStore from "./core/services/recordsStore.js";
import { initAppDir } from "./core/services/workspaceStore.js";
import { initStateStore } from "./core/services/stateStore.js";
import { initAppSettingsStore } from "./core/services/appSettingsStore.js";
import { initLogger, closeLogger, info, warn, error, debug, getRecordsPath, serializeError } from "./core/services/logger.js";
import { stopBackups } from "./core/services/backupStore.js";
import { getLogsDir, getRecordsDbPath, getThumbnailsDir, setDocumentsDirectory } from "./core/services/storagePaths.js";

import { validateMetadataEdit } from "./core/shared/postUpdate.js";
import { workspaceWriteProblem } from "./core/shared/writeProblem.js";
import { message } from "@shared/i18n/translate";
import { ACCEPTED_SLUG_MAX_LENGTH } from "@shared/metadataFields";
import type { AssetDeleteResult, AssetUploadResult, AssetUnsavedStep } from "@shared/ipc";
import { projectIndexEntry } from "./core/services/postFile.js";

function workspaceDir(id: string): string {
  const workspace = workspaceStore.getWorkspace(id);
  if (!workspace) throw new Error("Workspace not found");
  return workspace.dataDirectory;
}

// Publication and its post timestamp share this worker task. A caller ceasing
// to wait cannot skip the consequence of bytes already installed or removed.
function recordAssetEdit(dataDirectory: string, postId: string, filename: string): boolean {
  try {
    if (!postStore.recordAssetChange(dataDirectory, postId)) throw new Error("Post not found after its asset changed");
    return true;
  } catch (cause) {
    error("post modified time not updated after an asset change", { dataDirectory, postId, filename, error: serializeError(cause) });
    return false;
  }
}

// The reply's projection belongs to this published post, never a later queued
// operation or another filesystem read. Keep filePath for main-process logs.
function mutationResult(post: ReturnType<typeof postStore.updatePost>) {
  return post ? { ...post, summary: projectIndexEntry(post.frontMatter, path.basename(post.filePath), post.content) } : null;
}

// Workspaces whose leftover staged uploads this launch has cleared.
const sweptWorkspaces = new Set<string>();

export const storageTasks = {
  /** `documentsDirectory` is the OS's Documents folder, which only the main process can ask Electron for. */
  initialize(documentsDirectory?: string) {
    if (documentsDirectory) setDocumentsDirectory(documentsDirectory);
    const config = initAppDir();
    initLogger(getRecordsDbPath(), getLogsDir());
    const state = initStateStore();
    const settings = initAppSettingsStore();
    return { config, state, settings, recordsDbPath: getRecordsDbPath(), recordsPath: getRecordsPath(), thumbnailsDir: getThumbnailsDir() };
  },
  flush() {
    postStore.holdPendingFlushes();
    return postStore.flushAllPendingEdits();
  },
  /** Ends storage for the process; pending backup writes get `backupBoundMs`, 0 at OS session end. */
  finish(backupBoundMs: number) {
    try { stopBackups(backupBoundMs); }
    finally { closeLogger(); }
  },
  log(level: "debug" | "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) {
    ({ debug, info, warn, error })[level](message, fields);
  },
  fileExists(filePath: string) { return fs.existsSync(filePath); },
  readSourceMetadata(sourcePath: unknown, size: number) {
    if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) return undefined;
    try {
      const stat = fs.statSync(sourcePath, { throwIfNoEntry: false });
      if (!stat || !stat.isFile() || stat.size !== size) return undefined;
      return { mode: stat.mode & 0o7777, atime: stat.atime, mtime: stat.mtime };
    } catch { return undefined; }
  },
  listWorkspaces: workspaceStore.listWorkspaces,
  getWorkspace: workspaceStore.getWorkspace,
  createWorkspace: workspaceStore.createWorkspace,
  addExistingWorkspace: (dataDirectory: string) => workspaceStore.openWorkspace(dataDirectory),
  suggestWorkspaceLocation: workspaceStore.suggestWorkspaceLocation,
  updateWorkspace: workspaceStore.updateWorkspace,
  approveAiEndpoint: workspaceStore.approveAiEndpoint,
  deleteWorkspace(id: string) {
    const removed = workspaceStore.getWorkspace(id);
    const result = workspaceStore.deleteWorkspace(id);
    if (result && removed) postStore.clearCache(removed.dataDirectory);
    return result;
  },
  getWorkspaceConfig: configStore.getWorkspaceConfig,
  getSettings: configStore.getSettings,
  getConfigNotice: configStore.getConfigNotice,
  saveSettings: configStore.saveSettings,
  getRoleCall: configStore.getRoleCall,
  getAnthropicSettingsForClient: configStore.getAnthropicSettingsForClient,
  saveAnthropicSettings: configStore.saveAnthropicSettings,
  getTargets: configStore.getTargets,
  saveTargets: configStore.saveTargets,
  getAnalysisPrompts: configStore.getAnalysisPrompts,
  saveAnalysisPrompts: configStore.saveAnalysisPrompts,
  getGenerationPrompts: configStore.getGenerationPrompts,
  saveGenerationPrompts: configStore.saveGenerationPrompts,
  clearCache: postStore.clearCache,
  rebuildIndex: postStore.rebuildIndex,
  queueWorkspaceContent(wsId: string, id: string, content: string, editedAt: Date) {
    return postStore.queueContent(workspaceDir(wsId), id, content, editedAt);
  },
  queueWorkspaceMetadata(wsId: string, id: string, edits: unknown, editedAt: Date) {
    const dir = workspaceDir(wsId);
    const entry = postStore.getPostSummary(dir, id);
    if (!entry) return message("metadata.refusedNotFound");
    const validation = validateMetadataEdit(entry, edits);
    if (!validation.ok) {
      if (validation.reason === "locked") return message("metadata.refusedLocked");
      if (validation.reason === "invalid-slug") return message("metadata.refusedInvalidSlug", { max: ACCEPTED_SLUG_MAX_LENGTH });
      return message("metadata.refusedInvalid");
    }
    return postStore.queueMetadata(dir, id, validation.edits, editedAt);
  },
  queueContent: postStore.queueContent,
  queueMetadata: postStore.queueMetadata,
  flushPostEdits: postStore.flushPostEdits,
  getPost: postStore.getPost,
  createPost(...args: Parameters<typeof postStore.createPost>) {
    if (!configStore.getTargets(args[0]).some((target) => target.name === args[1])) throw new Error("Unknown target");
    if (!configStore.getSettings(args[0]).supportedLanguages.includes(args[2])) throw new Error("Unsupported language");
    if (args[3] && !postStore.postExists(args[0], args[3])) throw new Error("Source post not found");
    return postStore.createPost(...args);
  },
  updatePost(...args: Parameters<typeof postStore.updatePost>) {
    const post = postStore.getPost(args[0], args[1]);
    if (!post) return null;
    if (post.frontMatter.locked) throw Object.assign(new Error("This post is locked. Unlock it to edit it."), { name: "PostLockedError" });
    const source = args[2].frontMatter?.sourceId;
    if (source && !postStore.postExists(args[0], source)) throw new Error("Source post not found");
    return mutationResult(postStore.updatePost(...args));
  },
  changeStatus(...args: Parameters<typeof postStore.changeStatus>) {
    return mutationResult(postStore.changeStatus(...args));
  },
  setLocked(...args: Parameters<typeof postStore.setLocked>) {
    return mutationResult(postStore.setLocked(...args));
  },
  deletePost: postStore.deletePost,
  listReferrers: postStore.listReferrers,
  postExists: postStore.postExists,
  renameTarget(dir: string, oldName: string, newName: string) {
    const targets = configStore.getTargets(dir);
    const target = targets.find((item) => item.name === oldName);
    if (!target) throw new Error("Target not found");
    if (targets.some((item) => item.name === newName && item.name !== oldName)) throw new Error("A target with that name already exists");
    const renamed = postStore.renameTarget(dir, oldName, newName);
    target.name = newName;
    const saved = configStore.saveTargets(dir, targets);
    return { targets: saved, postsUpdated: renamed.updated, postsSkipped: renamed.skipped };
  },
  refreshIndex(dataDirectory: string) {
    // Listing its posts is the first thing an opened workspace does, so staged
    // uploads an earlier launch left behind are cleared here, once per launch.
    if (!sweptWorkspaces.has(dataDirectory)) {
      sweptWorkspaces.add(dataDirectory);
      try {
        const removed = assetStore.sweepStaging(dataDirectory);
        if (removed > 0) info("leftover staged uploads removed", { dataDirectory, removed });
      } catch (cause) {
        warn("leftover staged uploads could not be cleared", { dataDirectory, error: serializeError(cause) });
      }
    }
    return postStore.refreshIndex(dataDirectory);
  },
  listByStatus: postStore.listByStatus,
  countByStatus: postStore.countByStatus,
  holdPendingFlushes: postStore.holdPendingFlushes,
  resumePendingFlushes: postStore.resumePendingFlushes,
  listAssets: assetStore.listAssets,
  /**
   * Publishes a staged upload. The post's identity and lock are checked here, at
   * publication, since either can change while the bytes stream in. A write the
   * workspace folder refuses before the file is installed is a result the user
   * can act on, not an exception; the upload that staged the file removes it.
   */
  installAsset(...args: Parameters<typeof assetStore.installAsset>): AssetUploadResult {
    const [dataDirectory, postId, filename] = args;
    postStore.assertUnambiguousPostId(dataDirectory, postId);
    const post = postStore.getPost(dataDirectory, postId);
    if (!post) return { ok: false, admission: { code: "post-missing" } };
    if (post.frontMatter.locked) return { ok: false, admission: { code: "post-locked" } };
    let saved: ReturnType<typeof assetStore.installAsset>;
    const unsaved: AssetUnsavedStep[] = [];
    try {
      saved = assetStore.installAsset(...args);
    } catch (cause) {
      if (cause instanceof assetStore.AssetRecordError) {
        error("asset metadata save failed", { dataDirectory, postId, filename, error: serializeError(cause) });
        saved = { asset: cause.asset, changed: true };
        unsaved.push("details");
      } else {
        const problem = workspaceWriteProblem(cause);
        if (problem === null) throw cause;
        error("asset install failed", { dataDirectory, postId, filename, error: serializeError(cause) });
        return { ok: false, failure: { code: "workspace-unwritable", problem } };
      }
    }
    if (saved.changed && !recordAssetEdit(dataDirectory, postId, saved.asset.filename)) unsaved.push("modifiedTime");
    return { ok: true, asset: saved.asset, ...(unsaved.length > 0 ? { unsaved } : {}) };
  },
  deleteAsset(...args: Parameters<typeof assetStore.deleteAsset>): AssetDeleteResult {
    postStore.assertUnambiguousPostId(args[0], args[1]);
    const post = postStore.getPost(args[0], args[1]);
    if (!post) throw new Error("Post not found");
    if (post.frontMatter.locked) throw Object.assign(new Error("This post is locked. Unlock it to change its assets."), { name: "PostLockedError" });
    try {
      assetStore.deleteAsset(...args);
    } catch (cause) {
      if (!(cause instanceof assetStore.AssetRecordError)) throw cause;
      // Removal stands; the next asset read reconciles the stale details.
      error("asset metadata update failed", { dataDirectory: args[0], postId: args[1], filename: args[2], error: serializeError(cause) });
    }
    return recordAssetEdit(args[0], args[1], args[2]) ? {} : { unsaved: ["modifiedTime"] };
  },
  getUiState: stateStore.getUiState,
  updateUiState: stateStore.updateUiState,
  getAppSettingsLoad: appSettingsStore.getAppSettingsLoad,
  saveAppSettings: appSettingsStore.saveAppSettings,
  currentRecordsSession: recordsStore.currentRecordsSession,
  writeProviderCall: recordsStore.writeProviderCall,
};
export type StorageTasks = typeof storageTasks;
