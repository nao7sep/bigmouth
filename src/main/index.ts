import { app, BrowserWindow, powerMonitor } from "electron";

import {
  confirmCloseWithRefusedMetadata,
  confirmQuitWithUnsavedChanges,
  showStartupFailure,
} from "./dialogs.js";

import { initAppDir } from "./core/services/workspaceStore.js";
import { getLogsDir, getRecordsDbPath } from "./core/services/storagePaths.js";
import { holdPendingFlushes, resumePendingFlushes } from "./core/services/postStore.js";
import { QUIT_FLUSH_BOUND_MS, flushPendingEditsWithin } from "./core/services/quitFlush.js";
import { cancelOpenMessageDialogs } from "./plain-message-dialog.js";
import { initStateStore } from "./core/services/stateStore.js";
import { initAppSettingsStore } from "./core/services/appSettingsStore.js";
import { applyThemePreference, followOsThemeChanges } from "./theme.js";
import {
  initLogger,
  closeLogger,
  info,
  error as logError,
  serializeError,
  getRecordsPath,
  isDebugLoggingEnabled,
} from "./core/services/logger.js";
import { createMainWindow } from "./window.js";
import { notifyRecordsChanged } from "./records-window.js";
import { closeRecordsReader, initRecordsReader } from "./core/services/recordsReader.js";
import { onRecordStored } from "./core/services/recordsStore.js";
import { registerIpcHandlers } from "./ipc/index.js";
import { anyRefusedMetadata, forgetRefusedMetadata, holdsRefusedMetadata } from "./ipc/refusedMetadata.js";
import { registerAssetScheme, handleAssetProtocol } from "./assetProtocol.js";
import { installApplicationMenu } from "./menu.js";
import { applyLanguagePreference, detectComputerLanguage } from "./i18n.js";

app.setName("BigMouth");

// The stores below deliberately keep their indexes and write-behind buffers in
// process memory. A second process over the same workspace could therefore make
// decisions from stale state (including assigning the same export slug twice)
// and overwrite a newer index.json. One app process may own that state; a second
// launch is routed back to its existing window before it can touch durable data.
const ownsInstance = app.requestSingleInstanceLock();

let shuttingDown = false;

// The main window, apart from the records window beside it: closing it quits
// on Windows and Linux, and on macOS the Dock reopens it.
let mainWindow: BrowserWindow | null = null;

// Set when the OS itself is going down: quit must then never block on a dialog
// (modal-dialog-conventions) — flush within the bound and let the shutdown proceed.
let systemShutdown = false;

// Startup sequence: resolve the storage root, bring up logging, register the
// asset protocol and the IPC handlers the renderer calls, install the application
// menu, and open the window. The main process owns the single storage resolver and
// the filesystem (storage-path-conventions).
async function bootstrap(): Promise<void> {
  // First, so that even a failure below is reported in the computer's language.
  await detectComputerLanguage();
  const appConfig = initAppDir();
  initLogger(getRecordsDbPath(), getLogsDir());
  initRecordsReader(getRecordsDbPath());
  onRecordStored(notifyRecordsChanged);
  // State store (view state: pane widths + last workspace) resolves state.json under
  // the same storage root, so it must init after initAppDir(); after initLogger too,
  // so a self-heal warning on an invalid file is actually logged.
  initStateStore();
  // App-wide settings carry the theme, applied before the window exists so its
  // first frame, title bar, and background already match the saved choice.
  const appSettings = initAppSettingsStore();
  applyThemePreference(appSettings.theme);
  // The menu, dialogs and the window's first text all speak the saved language.
  await applyLanguagePreference(appSettings.language);
  followOsThemeChanges();
  info("app started", {
    version: __APP_VERSION__,
    workspaceCount: appConfig.workspaces.length,
    debug: isDebugLoggingEnabled(),
    records: getRecordsPath(),
  });

  handleAssetProtocol();
  registerIpcHandlers();
  installApplicationMenu();
  await openMainWindow();

  app.on("activate", () => {
    if (mainWindow === null) {
      void openMainWindow().catch(handleStartupFailure);
    }
  });
}

// Opens the window and subscribes to the platform's session-end signal. Windows
// raises "session-end" on the window (Electron has no app-level equivalent) and
// never raises before-quit for a logoff, so the handler itself saves and exits:
// the session may end as soon as it returns. macOS and Linux raise powerMonitor
// "shutdown" below, and their quit then arrives through before-quit.
//
// Off macOS, closing the main window is how the app quits, so the close becomes
// the quit: it saves first, and the window stays open when the user cancels.
// On macOS the app stays alive after the window closes, and the store writes
// the buffer on its debounce; closing it drops only what its fields show, so a
// metadata value the store refused (and so never buffered) asks first.
async function openMainWindow(): Promise<void> {
  const window = await createMainWindow();
  mainWindow = window;
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
    if (process.platform !== "darwin") app.quit();
  });
  window.on("session-end", () => {
    systemShutdown = true;
    shuttingDown = true;
    holdPendingFlushes();
    flushAtQuit();
    exitApp();
  });
  const ownerId = window.webContents.id;
  let askingToClose = false;
  window.on("close", (event) => {
    if (systemShutdown) return;
    if (process.platform !== "darwin") {
      event.preventDefault();
      app.quit();
      return;
    }
    if (!holdsRefusedMetadata(ownerId)) return;
    event.preventDefault();
    if (askingToClose) return;
    askingToClose = true;
    void (async () => {
      try {
        if (await confirmCloseWithRefusedMetadata() === "cancel") return;
        forgetRefusedMetadata(ownerId);
        if (!window.isDestroyed()) window.close();
      } finally {
        askingToClose = false;
      }
    })();
  });
}

/**
 * Writes the buffered post edits within the bound and logs what it could not
 * write. Returns whether they are all known to be on disk.
 */
function flushAtQuit(): boolean {
  const outcome = flushPendingEditsWithin();
  switch (outcome.kind) {
    case "flushed":
      if (outcome.failures.length === 0) return true;
      logError("pending edits flush failed at quit", { failures: outcome.failures });
      return false;
    case "expired":
      logError("pending edits flush did not finish at quit", { boundMs: QUIT_FLUSH_BOUND_MS });
      return false;
    case "crashed":
      logError("pending edits flush could not run at quit", { error: outcome.error });
      return false;
  }
}

function exitApp(): void {
  info("app shutting down", { reason: systemShutdown ? "os-shutdown" : "before-quit" });
  closeRecordsReader();
  closeLogger();
  app.exit(0);
}

let handlingStartupFailure = false;
async function handleStartupFailure(err: unknown): Promise<void> {
  if (handlingStartupFailure) return;
  handlingStartupFailure = true;
  console.error("[bigmouth] Bootstrap failed:", err instanceof Error ? err.stack : String(err));
  try {
    logError("bootstrap failed", { error: serializeError(err) });
  } catch {
    // The logger itself may be what failed; stderr above already carried it.
  }
  await showStartupFailure(err);
  app.exit(1);
}

if (!ownsInstance) {
  app.quit();
} else {
  // Must run before the app is ready: declares the raw-asset scheme privileged.
  registerAssetScheme();

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(bootstrap).catch(handleStartupFailure);

  // Quitting off macOS follows the main window's close (openMainWindow), once.
  // This listener only stops Electron's default quit when every window is gone.
  app.on("window-all-closed", () => {});

  // Clean shutdown (unsaved-edits-conventions, Quitting): hold the quit, write
  // any buffered content and metadata edits within the flush's bound, close the
  // records database, then exit deterministically. The post store owns pending
  // edits (write-behind), so this flush — not a renderer round-trip — is what
  // guarantees the newest keystroke is on disk. Menu Quit, Cmd+Q, the Dock's
  // Quit, closing the main window off macOS, and a macOS or Linux logout all
  // arrive here. When the user's posts cannot be written, a quit the user
  // started asks to cancel, retry or quit anyway; an ending session never asks.
  // A quit arriving while that runs, the question included, is held too, so
  // only the shutdown's own app.exit(0) ends the process.
  app.on("before-quit", (event) => {
    event.preventDefault();
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    holdPendingFlushes();

    void (async () => {
      for (;;) {
        const writeFailures = !flushAtQuit();
        const refusedMetadata = anyRefusedMetadata();
        if (systemShutdown || (!writeFailures && !refusedMetadata)) break;
        const choice = await confirmQuitWithUnsavedChanges({ writeFailures, refusedMetadata });
        if (systemShutdown || choice === "quit-anyway") break;
        if (choice === "cancel") {
          shuttingDown = false;
          resumePendingFlushes();
          return;
        }
      }
      exitApp();
    })();
  });

  // During OS shutdown or logout the app must not block: a question already
  // open is answered for it, and the quit that follows flushes and goes.
  // macOS and Linux only — Windows has no powerMonitor "shutdown"; its signal is
  // the window's "session-end", wired in openMainWindow.
  powerMonitor.on("shutdown", () => {
    systemShutdown = true;
    cancelOpenMessageDialogs();
  });

  process.on("uncaughtException", (err) => {
    logError("uncaught exception", { error: serializeError(err) });
  });

  process.on("unhandledRejection", (reason) => {
    logError("unhandled promise rejection", { error: serializeError(reason) });
  });
}
