# BigMouth's areas, and the tests that stand for them

`npm test` is the type check plus this whole suite, minus `live/`: at a few seconds it is already a
fixed, balanced run, so nothing selects a subset of it. `npm run test:full` adds `live/`, which sends
a real draft through the real Anthropic API.

This file is the balance judgement the `tests-folder-conventions` require — which areas BigMouth has,
and which tests stand for each — so a reader can tell what a green run covered, and an area with no
test standing for it is visible rather than merely absent. `tests/area-map.test.ts` holds every path
below to what is on disk.

Paths are relative to this folder.

| Area | What it covers | Tests standing for it |
|---|---|---|
| Workspaces | Creating, opening, and switching a workspace, and what each one owns | `main/services/workspaceStore.test.ts`, `main/ipc/workspaces.test.ts`, `main/shared/workspaceConfigShape.test.ts`, `renderer/components/WorkspaceModal.test.tsx`, `renderer/WorkspaceSession.test.tsx`, `main/services/dataDir.test.ts`, `main/services/storagePaths.test.ts` |
| Posts on disk | The per-post Markdown files, their index, their names, and how they are written | `main/services/postStore.test.ts`, `main/services/postFile.test.ts`, `main/services/postIndex.test.ts`, `main/shared/atomicWrite.test.ts`, `main/shared/filenames.test.ts`, `main/shared/postLifecycle.test.ts`, `main/shared/postUpdate.test.ts`, `main/ipc/posts.test.ts`, `shared/postOrder.test.ts`, `shared/postStatus.test.ts` |
| The AI checks | The Claude calls behind metadata, image prompts, and analysis, and what a refusal looks like | `main/ai/claude.test.ts`, `main/ai/factory.test.ts`, `main/ai/metadataGeneration.test.ts`, `main/ai/imaging.test.ts`, `main/ai/generationPrompts.test.ts`, `main/ai/promptTemplates.test.ts`, `main/ai/englishText.test.ts`, `main/ai/errorDetails.test.ts`, `main/ipc/metadata.test.ts`, `main/ipc/imaging.test.ts`, `main/ipc/analysis.test.ts`, `main/ipc/analysisPrompts.test.ts`, `main/ipc/generationPrompts.test.ts`, `main/ipc/aiConfigs.test.ts`, `shared/modelRegistry.test.ts` |
| Metadata | The fields a post carries, and what counts as filled | `shared/metadataFields.test.ts`, `renderer/util/metadataFields.test.ts`, `renderer/components/MetadataTab.test.tsx`, `renderer/util/dirtyFields.test.ts`, `renderer/util/counts.test.ts` |
| Assets | Images stored beside a post, and how the window reaches them | `main/services/assetStore.test.ts`, `main/ipc/assets.test.ts`, `main/assetProtocol.test.ts`, `shared/assetNames.test.ts`, `renderer/components/AssetsTab.test.tsx` |
| Export | Getting a finished post out of the app | `renderer/components/ExportModal.test.tsx`, `renderer/util/postTitle.test.ts`, `renderer/hooks/useCopyFeedback.test.ts` |
| Settings and keys | Saved settings, their validation, their backups, and where the API key comes from | `main/services/appSettingsStore.test.ts`, `main/services/configStore.test.ts`, `main/services/stateStore.test.ts`, `main/services/backupStore.test.ts`, `main/services/apiKeys.test.ts`, `main/shared/obfuscation.test.ts`, `shared/appSettings.test.ts`, `shared/settingsValidation.test.ts`, `main/ipc/settings.test.ts`, `main/ipc/targets.test.ts`, `renderer/components/SettingsModal.test.tsx` |
| The IPC boundary | The calls the renderer makes, and how a failure reaches the screen | `main/ipc/index.test.ts`, `shared/ipc.test.ts`, `renderer/api.test.ts`, `renderer/util/presentFailure.test.ts`, `renderer/components/OperationalResult.test.tsx`, `main/ipc/dialog.test.ts`, `main/external.test.ts` |
| The editor | Writing Markdown, highlighting it, and previewing it safely | `renderer/components/MarkdownEditor.test.tsx`, `renderer/components/editorHighlight.test.ts`, `renderer/components/PreviewTab.test.tsx`, `renderer/util/safeMarkdown.test.ts`, `renderer/util/textCleanup.test.ts`, `main/shared/textCleanup.test.ts`, `renderer/hooks/useComposing.test.ts` |
| The window's panes | What each pane shows, and moving between them | `renderer/App.test.tsx`, `renderer/components/LeftPane.test.tsx`, `renderer/components/CenterPane.test.tsx`, `renderer/components/RightPane.test.tsx`, `renderer/paneConstants.test.tsx`, `renderer/util/postBuckets.test.ts`, `renderer/util/selection.test.ts`, `renderer/components/PostPickerList.test.tsx`, `renderer/hooks/usePostPicker.test.ts`, `renderer/hooks/usePostListbox.test.ts` |
| Modals and keyboard | The modal stack, the composite controls, and the shortcuts | `renderer/components/ModalShell.test.tsx`, `renderer/hooks/useModalStack.test.tsx`, `renderer/components/ConfirmHost.test.tsx`, `renderer/components/NewPostModal.test.tsx`, `renderer/components/SourcePickerModal.test.tsx`, `renderer/components/AboutModal.test.tsx`, `renderer/components/ShortcutsModal.test.tsx`, `renderer/components/Menu.test.tsx`, `renderer/hooks/useTablist.test.ts`, `renderer/hooks/useRadioGroup.test.ts`, `renderer/util/compositeNav.test.ts`, `renderer/components/AnalysisTab.test.tsx`, `renderer/components/ImagingTab.test.tsx`, `renderer/externalDropBoundary.test.ts` |
| Window, theme, and styling | Window bounds and activity, light and dark, and the stylesheet | `main/window.test.ts`, `main/window-state-recovery.test.ts`, `main/theme.test.ts`, `main/preload-windowActivity.test.ts`, `renderer/windowActivity.test.ts`, `renderer/themeContrast.test.ts`, `renderer/styles.test.ts`, `renderer/App.css.test.ts`, `shared/layout.test.ts` |
| Startup and dialogs | Opening the app, and the dialogs that block it | `main/index.test.ts`, `main/plain-message-dialog.test.ts`, `main/plain-message-dialog-settlement.test.ts` |
| Logging | The log, what it summarises, and what the window can read of it | `main/services/logger.test.ts`, `main/shared/logSummaries.test.ts`, `main/ipc/logs.test.ts` |
| Times | The timestamps the app writes and shows | `main/shared/timestamps.test.ts`, `renderer/util/timestamps.test.ts` |
| The security boundary | The content policy the window runs under | `shared/csp.test.ts` |
| Packaging and launchers | What ships, how it is built, and the double-clickable launchers | `main/electron-vite-config.test.ts`, `main/launcher-runtime.test.ts`, `main/installer-config.test.ts` |
