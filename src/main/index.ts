import { app, BrowserWindow, powerMonitor } from "electron";

import { confirmQuitWithUnsavedChanges, showStartupFailure } from "./dialogs.js";

import { initAppDir } from "./core/services/workspaceStore.js";
import { getLogsDir } from "./core/services/storagePaths.js";
import { flushAllPendingContent } from "./core/services/postStore.js";
import { initStateStore } from "./core/services/stateStore.js";
import {
  initLogger,
  closeLogger,
  info,
  error as logError,
  serializeError,
  getCurrentLogFilePath,
  isDebugLoggingEnabled,
} from "./core/services/logger.js";
import { createMainWindow } from "./window.js";
import { registerIpcHandlers } from "./ipc/index.js";
import { registerAssetScheme, handleAssetProtocol } from "./assetProtocol.js";
import { installApplicationMenu } from "./menu.js";

app.setName("BigMouth");

// The stores below deliberately keep their indexes and write-behind buffers in
// process memory. A second process over the same workspace could therefore make
// decisions from stale state (including assigning the same export slug twice)
// and overwrite a newer index.json. One app process may own that state; a second
// launch is routed back to its existing window before it can touch durable data.
const ownsInstance = app.requestSingleInstanceLock();

let shuttingDown = false;

// Set when the OS itself is going down: quit must then never block on a dialog
// (modal-dialog-conventions) — flush best-effort and let the shutdown proceed.
let systemShutdown = false;

// Startup sequence: resolve the storage root, bring up file logging, register the
// asset protocol and the IPC handlers the renderer calls, install the application
// menu, and open the window. The main process owns the single storage resolver and
// the filesystem (storage-path-conventions).
function bootstrap(): void {
  const appConfig = initAppDir();
  initLogger(getLogsDir());
  // State store (view state: pane widths + last workspace) resolves state.json under
  // the same storage root, so it must init after initAppDir(); after initLogger too,
  // so a self-heal warning on an invalid file is actually logged.
  initStateStore();
  info("app started", {
    version: app.getVersion(),
    workspaceCount: appConfig.workspaces.length,
    debug: isDebugLoggingEnabled(),
    logFile: getCurrentLogFilePath(),
  });

  handleAssetProtocol();
  registerIpcHandlers();
  installApplicationMenu();
  openMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openMainWindow();
    }
  });
}

// Opens the window and subscribes to the platform's session-end signal. Windows
// raises "session-end" on the window (Electron has no app-level equivalent);
// macOS and Linux raise powerMonitor "shutdown" below. Both set the same flag,
// so a logoff on any platform takes the never-block path at quit.
function openMainWindow(): void {
  const window = createMainWindow();
  window.on("session-end", () => {
    systemShutdown = true;
  });
}

if (!ownsInstance) {
  app.quit();
} else {
  // Must run before the app is ready: declares the raw-asset scheme privileged.
  registerAssetScheme();

  app.on("second-instance", () => {
    const existing = BrowserWindow.getAllWindows()[0];
    if (!existing) return;
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  });

  app.whenReady().then(bootstrap).catch(async (err: unknown) => {
    // Logging itself may be the failing startup step, so stderr remains the floor.
    console.error("[bigmouth] Bootstrap failed:", err instanceof Error ? err.stack : String(err));
    try {
      logError("bootstrap failed", { error: serializeError(err) });
    } catch {
      // The logger itself may be what failed; stderr above already carried it.
    }
    await showStartupFailure();
    app.exit(1);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  // Clean shutdown: hold the quit once, write any buffered content edits, flush
  // the log file by closing it, then exit deterministically. The post store owns
  // pending content (write-behind), so this flush — not a renderer round-trip —
  // is what guarantees the newest keystroke is on disk. A second quit during
  // shutdown falls through (force-quit).
  app.on("before-quit", (event) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    event.preventDefault();

    const failures = flushAllPendingContent();
    void (async () => {
      if (failures.length > 0 && !systemShutdown) {
        logError("pending content flush failed at quit", { failures });
        if (await confirmQuitWithUnsavedChanges() === "cancel") {
          shuttingDown = false;
          return;
        }
      }

      info("app shutting down", { reason: systemShutdown ? "os-shutdown" : "before-quit" });
      closeLogger();
      app.exit(0);
    })();
  });

  // During OS shutdown or logout the app must not block: flush what it can and go.
  // macOS and Linux only — Windows has no powerMonitor "shutdown"; its signal is
  // the window's "session-end", wired in openMainWindow.
  powerMonitor.on("shutdown", () => {
    systemShutdown = true;
  });

  process.on("uncaughtException", (err) => {
    logError("uncaught exception", { error: serializeError(err) });
  });

  process.on("unhandledRejection", (reason) => {
    logError("unhandled promise rejection", { error: serializeError(reason) });
  });
}
