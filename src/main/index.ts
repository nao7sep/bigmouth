import { app, BrowserWindow, dialog, powerMonitor } from "electron";

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

// Must run before the app is ready: declares the raw-asset scheme privileged.
registerAssetScheme();

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

app.whenReady().then(bootstrap).catch((err: unknown) => {
  // Logging itself may be the failing startup step, so stderr remains the floor.
  const message = err instanceof Error ? err.message : String(err);
  console.error("[bigmouth] Bootstrap failed:", err instanceof Error ? err.stack : String(err));
  try {
    logError("bootstrap failed", { error: serializeError(err) });
  } catch {
    // The logger itself may be what failed; stderr above already carried it.
  }
  dialog.showErrorBox(
    "BigMouth could not start",
    `${message}\n\nNo posts or workspace documents were changed. Check the session log, then start BigMouth again.`,
  );
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
  if (failures.length > 0 && !systemShutdown) {
    logError("pending content flush failed at quit", { failures });
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      title: "Unsaved changes",
      message: "Some edits could not be saved.",
      detail:
        "BigMouth could not write your latest changes to disk. " +
        "Quit anyway and lose them, or cancel and copy your text somewhere safe? " +
        "The editor shows why each post could not be saved.",
      // Cancel is the safest action, so it is the default and the Escape path.
      buttons: ["Cancel", "Quit Anyway"],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice === 0) {
      shuttingDown = false;
      return;
    }
  }

  info("app shutting down", { reason: systemShutdown ? "os-shutdown" : "before-quit" });
  closeLogger();
  app.exit(0);
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
