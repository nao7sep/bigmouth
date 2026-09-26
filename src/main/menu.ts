import { Menu, type MenuItemConstructorOptions } from "electron";

import type { Translator } from "@shared/i18n/translate";
import { mainTranslator } from "./i18n.js";

const APP = "BigMouth";

// A deliberate native application menu (app-chrome-conventions: not the toolkit
// default). BigMouth's own actions live in the in-window UI; this menu carries
// only the platform essentials — the app/quit menu, the full Edit roles (so
// copy/paste/undo work in text inputs), a View menu (dev reload + devtools in dev
// only, plus zoom and fullscreen), and the standard Window menu.
//
// Every item is labelled from the catalogues: Electron's role labels are
// English. Roles still carry the behavior — the standard actions sent to
// whatever has focus, the Services menu, and the Window menu macOS lists open
// windows in — and macOS adds its own Edit items whatever the menu's title.
export function buildApplicationMenu(translator: Translator = mainTranslator()): Menu {
  return Menu.buildFromTemplate(applicationMenuTemplate(translator, process.platform));
}

export function applicationMenuTemplate(
  { t }: Translator,
  platform: NodeJS.Platform,
): MenuItemConstructorOptions[] {
  const isMac = platform === "darwin";
  const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
  const separator: MenuItemConstructorOptions = { type: "separator" };

  const appMenu: MenuItemConstructorOptions = {
    role: "appMenu",
    label: APP,
    submenu: [
      { role: "about", label: t("nativeMenu.about", { app: APP }) },
      separator,
      { role: "services", label: t("nativeMenu.services") },
      separator,
      { role: "hide", label: t("nativeMenu.hide", { app: APP }) },
      { role: "hideOthers", label: t("nativeMenu.hideOthers") },
      { role: "unhide", label: t("nativeMenu.showAll") },
      separator,
      { role: "quit", label: t("nativeMenu.quit", { app: APP }) },
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    role: "editMenu",
    label: t("nativeMenu.edit"),
    submenu: [
      { role: "undo", label: t("nativeMenu.undo") },
      { role: "redo", label: t("nativeMenu.redo") },
      separator,
      { role: "cut", label: t("nativeMenu.cut") },
      { role: "copy", label: t("nativeMenu.copy") },
      { role: "paste", label: t("nativeMenu.paste") },
      ...(isMac
        ? ([{ role: "pasteAndMatchStyle", label: t("nativeMenu.pasteAndMatchStyle") }] as MenuItemConstructorOptions[])
        : []),
      { role: "delete", label: t("nativeMenu.delete") },
      { role: "selectAll", label: t("nativeMenu.selectAll") },
      ...(isMac
        ? ([
            separator,
            {
              label: t("nativeMenu.speech"),
              submenu: [
                { role: "startSpeaking", label: t("nativeMenu.startSpeaking") },
                { role: "stopSpeaking", label: t("nativeMenu.stopSpeaking") },
              ],
            },
          ] as MenuItemConstructorOptions[])
        : []),
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: t("nativeMenu.view"),
    submenu: [
      ...(isDev
        ? ([
            { role: "reload", label: t("nativeMenu.reload") },
            { role: "forceReload", label: t("nativeMenu.forceReload") },
            { role: "toggleDevTools", label: t("nativeMenu.toggleDevTools") },
            separator,
          ] as MenuItemConstructorOptions[])
        : []),
      { role: "resetZoom", label: t("nativeMenu.actualSize") },
      { role: "zoomIn", label: t("nativeMenu.zoomIn") },
      { role: "zoomOut", label: t("nativeMenu.zoomOut") },
      separator,
      { role: "togglefullscreen", label: t("nativeMenu.toggleFullScreen") },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    role: "windowMenu",
    label: t("nativeMenu.window"),
    submenu: isMac
      ? [
          { role: "minimize", label: t("nativeMenu.minimize") },
          { role: "zoom", label: t("nativeMenu.zoom") },
          separator,
          { role: "front", label: t("nativeMenu.bringAllToFront") },
        ]
      : [
          { role: "minimize", label: t("nativeMenu.minimize") },
          { role: "close", label: t("nativeMenu.close") },
        ],
  };

  return [...(isMac ? [appMenu] : []), editMenu, viewMenu, windowMenu];
}

/** Installs the menu in the current interface language; called again when it changes. */
export function installApplicationMenu(): void {
  Menu.setApplicationMenu(buildApplicationMenu());
}
