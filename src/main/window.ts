import { BrowserWindow, Menu, nativeTheme, screen } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { windowMinimumForZoom } from "@shared/layout";
import { getUiState, updateUiState } from "./core/services/stateStore.js";
import { error as logError, serializeError } from "./core/services/logger.js";
import { isAllowedExternalUrl, openExternalUrl } from "./ipc/external.js";

export { isAllowedExternalUrl } from "./ipc/external.js";

// Matches the renderer `--bm-bg` (#f4efe8 in App.css) so the pre-paint window
// background does not flash a different color before the page loads.
const WINDOW_BACKGROUND = "#f4efe8";
const __dirname = dirname(fileURLToPath(import.meta.url));

function openExternalIfAllowed(rawUrl: string): void {
  if (isAllowedExternalUrl(rawUrl)) {
    void openExternalUrl(rawUrl).catch((error: unknown) => {
      logError("unowned external navigation failed", { url: rawUrl, error: serializeError(error) });
    });
  }
}

// The BrowserWindow construction options. Exported as a pure helper so the
// hardening flags and the derived minimums are verified without driving a real
// window — see tests/main/window.test.ts. The minimum size is the pane-row plus chrome,
// sourced from @shared/layout (app-chrome-conventions) — never hand-typed, so it
// can never disagree with the renderer's pane minimums.
export function zoomFactorForLevel(zoomLevel: number): number {
  return 1.2 ** zoomLevel;
}

export function boundWindowMinimum(
  required: { width: number; height: number },
  workArea: { width: number; height: number },
): { width: number; height: number } {
  return {
    width: Math.min(required.width, workArea.width),
    height: Math.min(required.height, workArea.height),
  };
}

export function buildWindowOptions(
  zoomFactor = 1,
  workArea?: { width: number; height: number },
): Electron.BrowserWindowConstructorOptions {
  const required = windowMinimumForZoom(zoomFactor);
  const minimum =
    workArea === undefined ? required : boundWindowMinimum(required, workArea);
  return {
    width: 1480,
    height: 940,
    minWidth: minimum.width,
    minHeight: minimum.height,
    show: false,
    backgroundColor: WINDOW_BACKGROUND,
    titleBarStyle: "default",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      zoomFactor,
    },
  };
}

/**
 * Restores the saved zoom level and keeps it saved.
 *
 * Electron's zoom roles mutate webContents in memory only, so a user who zoomed
 * for readability was back at 100% on every relaunch with no indication why —
 * the app-chrome conventions require the level to persist wherever zoom exists.
 * `zoom-changed` covers the trackpad/scroll gesture; the menu roles do not fire
 * it, so the level is read back after each of them too.
 */
function configureZoom(window: BrowserWindow): void {
  const { zoomLevel } = getUiState();
  window.webContents.setZoomLevel(zoomLevel);

  const remember = (): void => {
    const required = windowMinimumForZoom(window.webContents.getZoomFactor());
    const workArea = screen.getDisplayMatching(window.getBounds()).workAreaSize;
    const minimum = boundWindowMinimum(required, workArea);
    window.setMinimumSize(minimum.width, minimum.height);
    const level = window.webContents.getZoomLevel();
    if (level !== getUiState().zoomLevel) updateUiState({ zoomLevel: level });
  };

  // Apply the restored level's native floor before the hidden window is shown.
  remember();
  window.webContents.on("zoom-changed", () => setTimeout(remember, 0));
  // Native zoom roles do not emit `zoom-changed`. A keyboard role is observed
  // after Electron handles its input; a pointer-selected menu role is observed
  // when focus returns. Blur/close remain persistence fallbacks.
  window.webContents.on("before-input-event", (_event, input) => {
    const modifier = process.platform === "darwin" ? input.meta : input.control;
    if (modifier && ["+", "=", "-", "0"].includes(input.key)) {
      setTimeout(remember, 0);
    }
  });
  window.on("focus", () => setTimeout(remember, 0));
  window.on("blur", remember);
  window.on("move", remember);
  window.on("close", remember);
  const onDisplayMetricsChanged = (): void => remember();
  screen.on("display-metrics-changed", onDisplayMetricsChanged);
  window.once("closed", () =>
    screen.removeListener("display-metrics-changed", onDisplayMetricsChanged),
  );
}

export async function createMainWindow(): Promise<BrowserWindow> {
  // BigMouth is a light app; force the light theme so a dark-mode host still
  // paints a light native title bar that matches the UI (app-chrome-conventions).
  nativeTheme.themeSource = "light";

  const zoomFactor = zoomFactorForLevel(getUiState().zoomLevel);
  const window = new BrowserWindow(
    buildWindowOptions(zoomFactor, screen.getPrimaryDisplay().workAreaSize),
  );

  window.once("ready-to-show", () => {
    configureZoom(window);
    window.show();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfAllowed(url);
    return { action: "deny" };
  });

  // The renderer is a single-page app that never legitimately navigates the
  // top-level frame. Block any attempt to replace it; a same-URL reload is left
  // alone so dev full-reloads still work, and a real external link opens in the
  // browser.
  window.webContents.on("will-navigate", (event, url) => {
    if (url === window.webContents.getURL()) {
      return;
    }
    event.preventDefault();
    openExternalIfAllowed(url);
  });

  window.webContents.on("context-menu", (_event, params) => {
    if (!params.isEditable && !params.selectionText) return;

    const template: Electron.MenuItemConstructorOptions[] = [];

    if (params.misspelledWord) {
      if (params.dictionarySuggestions.length > 0) {
        for (const word of params.dictionarySuggestions) {
          template.push({ label: word, click: () => window.webContents.replaceMisspelling(word) });
        }
      } else {
        template.push({ label: "No suggestions", enabled: false });
      }
      template.push({ type: "separator" });
    }

    if (params.isEditable) {
      template.push(
        { role: "undo", enabled: params.editFlags.canUndo },
        { role: "redo", enabled: params.editFlags.canRedo },
        { type: "separator" },
        { role: "cut", enabled: params.editFlags.canCut },
      );
    }

    template.push({ role: "copy", enabled: params.editFlags.canCopy });

    if (params.isEditable) {
      template.push(
        { role: "paste", enabled: params.editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll", enabled: params.editFlags.canSelectAll },
      );
    }

    Menu.buildFromTemplate(template).popup();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    // The Content-Security-Policy travels in the HTML, not a response header:
    // this is a file:// load, which a header CSP cannot reach. See src/shared/csp.ts.
    await window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}
