import { BrowserWindow, nativeTheme, screen } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CHANNELS } from "@shared/ipc";
import { RECORDS_WINDOW_MIN_HEIGHT, RECORDS_WINDOW_MIN_WIDTH } from "@shared/layout";
import { serializeError, warn } from "./core/services/logger.js";
import { mainTranslator } from "./i18n.js";
import { windowBackground } from "./theme.js";
import { boundWindowMinimum, configureWindowActivity, loadRendererPage } from "./window.js";
import { createWindowWithUsablePersistedBounds } from "./window-state-recovery.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The records window shows records.sqlite3. It is a durable secondary window
// with its own placement (window-conventions, Placement), and there is only
// ever one: opening it again brings it forward.
let recordsWindow: BrowserWindow | null = null;

export function buildRecordsWindowOptions(
  title: string,
  workArea?: { width: number; height: number },
): Electron.BrowserWindowConstructorOptions {
  const required = { width: RECORDS_WINDOW_MIN_WIDTH, height: RECORDS_WINDOW_MIN_HEIGHT };
  const minimum = workArea === undefined ? required : boundWindowMinimum(required, workArea);
  return {
    name: "records",
    windowStatePersistence: {
      bounds: true,
      displayMode: process.platform === "win32",
    },
    title,
    width: Math.min(1240, workArea?.width ?? 1240),
    height: Math.min(820, workArea?.height ?? 820),
    minWidth: minimum.width,
    minHeight: minimum.height,
    show: false,
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

/** Tells the records window, when it is open, that a record was stored. */
export function notifyRecordsChanged(): void {
  if (recordsWindow !== null && !recordsWindow.isDestroyed() && !recordsWindow.webContents.isDestroyed()) {
    recordsWindow.webContents.send(CHANNELS.recordsChanged);
  }
}

export async function openRecordsWindow(): Promise<void> {
  if (recordsWindow !== null && !recordsWindow.isDestroyed()) {
    if (recordsWindow.isMinimized()) recordsWindow.restore();
    recordsWindow.show();
    recordsWindow.focus();
    return;
  }

  let workArea: { width: number; height: number } | undefined;
  try {
    workArea = screen.getPrimaryDisplay().workAreaSize;
  } catch (error) {
    warn("records window work area unavailable; using designed size", { error: serializeError(error) });
  }
  const options = buildRecordsWindowOptions(mainTranslator().t("records.title"), workArea);
  const window = createWindowWithUsablePersistedBounds("records", () => new BrowserWindow(options));
  recordsWindow = window;
  window.once("closed", () => {
    if (recordsWindow === window) recordsWindow = null;
  });
  configureWindowActivity(window);
  window.once("ready-to-show", () => window.show());

  try {
    await loadRendererPage(window, "records.html");
  } catch (error) {
    window.destroy();
    throw error;
  }
}
