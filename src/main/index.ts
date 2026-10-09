import { app, BrowserWindow, powerMonitor } from "electron";

import {
  confirmCloseWithRefusedMetadata,
  confirmQuitWithUnsavedChanges,
  showStartupFailure,
} from "./dialogs.js";

import { initialize, log as storageLog, resumePendingFlushes } from "./storageAccess.js";
import { storageOwner } from "./storageOwner.js";
const QUIT_FLUSH_BOUND_MS = 2000;
import { cancelOpenMessageDialogs } from "./plain-message-dialog.js";
import { applyThemePreference, followOsThemeChanges } from "./theme.js";
import {
  setLogSink,
  info,
  error as logError,
  serializeError,
  isDebugLoggingEnabled,
} from "./core/services/logger.js";
import { createMainWindow } from "./window.js";
import { notifyRecordsChanged } from "./records-window.js";
import { closeRecordsReader, initRecordsReader } from "./core/services/recordsReader.js";
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
if (ownsInstance) setLogSink((level, message, fields) => {
  void storageLog(level, message, fields).catch((error) => console.error("[bigmouth] Log could not reach storage", error));
});

let shuttingDown = false;

// The main window, apart from the records window beside it: closing it quits
// on Windows and Linux, and on macOS the Dock reopens it.
let mainWindow: BrowserWindow | null = null;

// When the OS itself is going down, quit must never block on a dialog
// (modal-dialog-conventions): flush within the bound and let the shutdown
// proceed. Windows' session-end ends the process itself. macOS and Linux raise
// powerMonitor "shutdown", and Electron reports no cancelled logout, so that
// signal covers only a quit within SHUTDOWN_SIGNAL_WINDOW_MS of it; a later quit
// is the user's again and asks about a failed save. A window too short could
// show a question during a real logout and block it; one too long only skips
// the question for a quit soon after a cancelled logout.
const SHUTDOWN_SIGNAL_WINDOW_MS = 60_000;
let sessionEnding = false;
let shutdownSignalAt: number | null = null;
const systemShutdown = () =>
  sessionEnding || (shutdownSignalAt !== null && Date.now() - shutdownSignalAt <= SHUTDOWN_SIGNAL_WINDOW_MS);

// Startup sequence: resolve the storage root, bring up logging, register the
// asset protocol and the IPC handlers the renderer calls, install the application
// menu, and open the window. The main process owns the single storage resolver and
// the filesystem (storage-path-conventions).
async function bootstrap(): Promise<void> {
  // First, so that even a failure below is reported in the computer's language.
  await detectComputerLanguage();
  storageOwner.onRecordStored(notifyRecordsChanged);
  const initialized = await initialize();
  const appConfig = initialized.config;
  const appSettings = initialized.settings;
  initRecordsReader(initialized.recordsDbPath);
  applyThemePreference(appSettings.theme);
  // The menu, dialogs and the window's first text all speak the saved language.
  await applyLanguagePreference(appSettings.language);
  followOsThemeChanges();
  info("app started", {
    version: __APP_VERSION__,
    workspaceCount: appConfig.workspaces.length,
    debug: isDebugLoggingEnabled(),
    records: initialized.recordsPath,
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
    sessionEnding = true;
    shuttingDown = true;
    logFlushOutcome(storageOwner.flushWithin(QUIT_FLUSH_BOUND_MS));
    exitAppWithin();
  });
  const ownerId = window.webContents.id;
  let askingToClose = false;
  window.on("close", (event) => {
    if (systemShutdown()) return;
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
      } catch (error) {
        logError("close confirmation failed; window remains open", { error: serializeError(error) });
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
async function flushAtQuit(): Promise<boolean> {
  return logFlushOutcome(await storageOwner.flushAsync(QUIT_FLUSH_BOUND_MS));
}

function logFlushOutcome(outcome: Awaited<ReturnType<typeof storageOwner.flushAsync>>): boolean {
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

// Electron's app.exit never returns while a worker thread is blocked in a native
// filesystem call, such as the storage worker on a stalled network or removable
// volume: neither worker.terminate() nor a timer armed beforehand gets it out.
// When the storage worker has not settled by the finish bound, the process is
// killed instead, so quit and logout always end. A kill cannot tear a post:
// atomic writes rename only complete files into place, at worst leaving an
// inert .tmp. Records go through that same worker, so only the console hears.
function terminateApp(storageSettled: boolean): void {
  closeRecordsReader();
  if (!storageSettled) {
    console.error("[bigmouth] Storage did not settle within the exit bound; ending the process.");
    process.kill(process.pid, "SIGKILL");
    return;
  }
  void storageOwner.stop();
  app.exit(0);
}

async function exitApp(): Promise<void> {
  let settled = false;
  try { settled = await storageOwner.finishAsync(1000); }
  finally { terminateApp(settled); }
}

function exitAppWithin(): void {
  let settled = false;
  try { settled = storageOwner.finishWithin(1000); }
  finally { terminateApp(settled); }
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

    void (async () => {
      try {
        for (;;) {
          const writeFailures = !await flushAtQuit();
          const refusedMetadata = anyRefusedMetadata();
          if (systemShutdown() || (!writeFailures && !refusedMetadata)) break;
          const choice = await confirmQuitWithUnsavedChanges({ writeFailures, refusedMetadata });
          if (systemShutdown() || choice === "quit-anyway") break;
          if (choice === "cancel") {
            shuttingDown = false;
            void resumePendingFlushes().catch((error) => console.error("[bigmouth] Storage could not resume", error));
            return;
          }
        }
        await exitApp();
      } catch (error) {
        shuttingDown = false;
        void resumePendingFlushes().catch((error) => console.error("[bigmouth] Storage could not resume", error));
        logError("quit confirmation failed; quit cancelled", { error: serializeError(error) });
      }
    })();
  });

  // During OS shutdown or logout the app must not block: a question already
  // open is answered for it, and the quit that follows flushes and goes.
  // macOS and Linux only — Windows has no powerMonitor "shutdown"; its signal is
  // the window's "session-end", wired in openMainWindow.
  powerMonitor.on("shutdown", () => {
    shutdownSignalAt = Date.now();
    cancelOpenMessageDialogs();
  });

  process.on("uncaughtException", (err) => {
    logError("uncaught exception", { error: serializeError(err) });
  });

  process.on("unhandledRejection", (reason) => {
    logError("unhandled promise rejection", { error: serializeError(reason) });
  });
}
