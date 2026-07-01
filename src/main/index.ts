import { app, BrowserWindow } from "electron";

import { initAppDir, getLogsDir } from "./core/services/workspaceStore.js";
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
import { runBackupInBackground } from "./core/backup/backupService.js";
import { registerIpcHandlers } from "./ipc/index.js";
import { registerAssetScheme, handleAssetProtocol } from "./assetProtocol.js";
import { installApplicationMenu } from "./menu.js";

app.setName("BigMouth");

// Must run before the app is ready: declares the raw-asset scheme privileged.
registerAssetScheme();

let shuttingDown = false;

// Startup sequence: resolve the storage root, bring up file logging, register the
// asset protocol and the IPC handlers the renderer calls, install the application
// menu, and open the window. The main process owns the single storage resolver and
// the filesystem (storage-path-conventions).
function bootstrap(): void {
  const appConfig = initAppDir();
  initLogger(getLogsDir());
  info("app started", {
    version: app.getVersion(),
    workspaceCount: appConfig.workspaces.length,
    debug: isDebugLoggingEnabled(),
    logFile: getCurrentLogFilePath(),
  });

  handleAssetProtocol();
  registerIpcHandlers();
  installApplicationMenu();
  createMainWindow();

  // Just-in-case data backup: fire-and-forget on the event loop after the window is created, so it never
  // delays startup. config.json and workspaces.json are already materialized by initAppDir above.
  runBackupInBackground();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}

app.whenReady().then(bootstrap).catch((err: unknown) => {
  // initAppDir / initLogger can throw before the logger exists (e.g. an unusable
  // storage root) — fall back to stderr so the failure is still visible, then
  // exit non-zero rather than leave a half-initialized window.
  console.error("[bigmouth] Bootstrap failed:", err instanceof Error ? err.stack : String(err));
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Clean shutdown: hold the quit once, flush the log file by closing it, then exit
// deterministically. A second quit during shutdown falls through (force-quit).
app.on("before-quit", (event) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  event.preventDefault();
  info("app shutting down", { reason: "before-quit" });
  closeLogger();
  app.exit(0);
});

process.on("uncaughtException", (err) => {
  logError("uncaught exception", { error: serializeError(err) });
});

process.on("unhandledRejection", (reason) => {
  logError("unhandled promise rejection", { error: serializeError(reason) });
});
