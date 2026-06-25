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
import { registerIpcHandlers } from "./ipc/index.js";

app.setName("BigMouth");

let shuttingDown = false;

// Resolve the storage root, bring up file logging, then open the window. This is
// the desktop counterpart of the old server bootstrap: the main process now owns
// the single storage resolver and the filesystem (storage-path-conventions), and
// the renderer reaches it over IPC (wired in later phases) rather than HTTP.
function bootstrap(): void {
  const appConfig = initAppDir();
  initLogger(getLogsDir());
  info("app started", {
    version: app.getVersion(),
    workspaceCount: appConfig.workspaces.length,
    debug: isDebugLoggingEnabled(),
    logFile: getCurrentLogFilePath(),
  });

  registerIpcHandlers();
  createMainWindow();

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
