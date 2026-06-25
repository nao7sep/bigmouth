import { BrowserWindow, Menu, nativeTheme, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from "@shared/layout";

// Matches the renderer `--bm-bg` (#f4efe8 in App.css) so the pre-paint window
// background does not flash a different color before the page loads.
const WINDOW_BACKGROUND = "#f4efe8";
const __dirname = dirname(fileURLToPath(import.meta.url));

// Schemes the app is willing to hand to the OS via shell.openExternal. Anything
// else a renderer asks to open (file:, custom handlers, …) is ignored.
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

// Packaged-build Content-Security-Policy (defense-in-depth on top of context
// isolation). The dev server needs inline/eval and a websocket for HMR, so this
// is applied only to the built app. style-src allows 'unsafe-inline' because
// CodeMirror injects its editor theme as runtime <style> elements; img-src allows
// data: for inline image URIs that sanitized markdown may carry. The raw-asset
// custom scheme is added to img-src / connect-src in Phase 5, when that protocol
// replaces the old HTTP /raw endpoint.
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: bigmouth-asset:",
  "font-src 'self'",
  "connect-src 'self' bigmouth-asset:",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// Whether a URL may be handed to the OS browser. Exported so the allowlist is
// covered without driving a real BrowserWindow.
export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

// The response-header transform applied in the packaged build: stamp the CSP on
// without disturbing headers already present. Exported so the exact policy is
// verified in a unit test (the runtime path can't be exercised headlessly).
export function withContentSecurityPolicy(
  responseHeaders: Record<string, string[]> | undefined,
): Record<string, string[]> {
  return {
    ...(responseHeaders ?? {}),
    "Content-Security-Policy": [PRODUCTION_CSP],
  };
}

function openExternalIfAllowed(rawUrl: string): void {
  if (isAllowedExternalUrl(rawUrl)) {
    void shell.openExternal(rawUrl);
  }
}

// The BrowserWindow construction options. Exported as a pure helper so the
// default size and the derived minimums are verified in a unit test without
// driving a real window. The minimum size is the pane-row minimum plus chrome,
// sourced from @shared/layout (app-chrome-conventions) — never hand-typed, so it
// can never disagree with the renderer's pane minimums.
export function buildWindowOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    width: 1480,
    height: 940,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    backgroundColor: WINDOW_BACKGROUND,
    titleBarStyle: "default",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

export function createMainWindow(): BrowserWindow {
  // BigMouth is a light app; force the light theme so a dark-mode host still
  // paints a light native title bar that matches the UI (app-chrome-conventions).
  nativeTheme.themeSource = "light";

  const window = new BrowserWindow(buildWindowOptions());

  window.once("ready-to-show", () => {
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
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    // Packaged build only: enforce the CSP via a response header. (Re-registering
    // on a subsequent window replaces the single handler, which is harmless.)
    window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: withContentSecurityPolicy(details.responseHeaders) });
    });
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}
