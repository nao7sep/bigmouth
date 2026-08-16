import { app, BrowserWindow, dialog } from "electron";

import { initAppDir, getLogsDir } from "./core/services/workspaceStore.js";
import { drainStateQuarantineNotices, initStateStore } from "./core/services/stateStore.js";
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
  createMainWindow();

  // Report any quarantine the startup loads performed: the store was set aside
  // with its bytes preserved and defaults took over — the user hears it from a
  // dialog, never only from the log (storage-path conventions).
  const quarantined = drainStateQuarantineNotices();
  if (quarantined.length > 0) {
    dialog.showErrorBox(
      "A settings file was reset",
      "A file was unreadable and has been set aside so nothing is lost:\n\n" +
        quarantined.join("\n") +
        "\n\nbigmouth started with a default layout. Your posts and workspaces are untouched.",
    );
  }

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
