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
import { initLogger, closeLogger, info, warn, error, debug, getRecordsPath } from "./core/services/logger.js";
import { stopBackups } from "./core/services/backupStore.js";
import { getLogsDir, getRecordsDbPath } from "./core/services/storagePaths.js";

import { validateMetadataEdit } from "./core/shared/postUpdate.js";
import { message } from "@shared/i18n/translate";
import { ACCEPTED_SLUG_MAX_LENGTH } from "@shared/metadataFields";

function workspaceDir(id: string): string {
  const workspace = workspaceStore.getWorkspace(id);
  if (!workspace) throw new Error("Workspace not found");
  return workspace.dataDirectory;
}

export const storageTasks = {
  initialize() {
    const config = initAppDir();
    initLogger(getRecordsDbPath(), getLogsDir());
    const state = initStateStore();
    const settings = initAppSettingsStore();
    return { config, state, settings, recordsDbPath: getRecordsDbPath(), recordsPath: getRecordsPath() };
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
  readAssetFile(filePath: string) { return fs.readFileSync(filePath); },
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
  openOrCreateWorkspace: workspaceStore.openOrCreateWorkspace,
  suggestWorkspaceLocation: workspaceStore.suggestWorkspaceLocation,
  updateWorkspace: workspaceStore.updateWorkspace,
  deleteWorkspace: workspaceStore.deleteWorkspace,
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
    return postStore.updatePost(...args);
  },
  recordAssetChange: postStore.recordAssetChange,
  changeStatus: postStore.changeStatus,
  setLocked: postStore.setLocked,
  deletePost: postStore.deletePost,
  getPostSummary: postStore.getPostSummary,
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
  refreshIndex: postStore.refreshIndex,
  listByStatus: postStore.listByStatus,
  countByStatus: postStore.countByStatus,
  holdPendingFlushes: postStore.holdPendingFlushes,
  resumePendingFlushes: postStore.resumePendingFlushes,
  listAssets: assetStore.listAssets,
  saveAssetFile(...args: Parameters<typeof assetStore.saveAssetFile>) {
    const post = postStore.getPost(args[0], args[1]);
    if (!post) throw new Error("Post not found");
    if (post.frontMatter.locked) throw Object.assign(new Error("This post is locked. Unlock it to change its assets."), { name: "PostLockedError" });
    return assetStore.saveAssetFile(...args);
  },
  deleteAsset(...args: Parameters<typeof assetStore.deleteAsset>) {
    const post = postStore.getPost(args[0], args[1]);
    if (!post) throw new Error("Post not found");
    if (post.frontMatter.locked) throw Object.assign(new Error("This post is locked. Unlock it to change its assets."), { name: "PostLockedError" });
    return assetStore.deleteAsset(...args);
  },
  getUiState: stateStore.getUiState,
  updateUiState: stateStore.updateUiState,
  getAppSettingsLoad: appSettingsStore.getAppSettingsLoad,
  saveAppSettings: appSettingsStore.saveAppSettings,
  currentRecordsSession: recordsStore.currentRecordsSession,
  writeProviderCall: recordsStore.writeProviderCall,
};
export type StorageTasks = typeof storageTasks;
