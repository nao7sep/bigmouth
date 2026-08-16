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
  // Two failures land here. initAppDir / initLogger can throw before the logger
  // exists (an unusable storage root), which is why stderr is still the floor. A
  // store that is corrupt AND cannot be set aside also throws here, from
  // initStateStore, which runs AFTER initLogger — so log it, and above all SAY so:
  // exiting silently over a settings file is not a halt, it is a launch that does
  // nothing (storage-path conventions: a halt names the store and reaches the user).
  const message = err instanceof Error ? err.message : String(err);
  console.error("[bigmouth] Bootstrap failed:", err instanceof Error ? err.stack : String(err));
  try {
    logError("bootstrap failed", { error: message });
  } catch {
    // The logger itself may be what failed; stderr above already carried it.
  }
  dialog.showErrorBox(
    "BigMouth could not start",
    "A settings file could not be read, and BigMouth could not set it aside either — so it has been " +
      "left exactly where it is rather than risk overwriting it.\n\n" +
      message +
      "\n\nYour posts and workspaces are not affected. Repair or move the file under the BigMouth " +
      "data folder, then start BigMouth again.",
  );
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
