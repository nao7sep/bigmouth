import { Menu, type MenuItemConstructorOptions } from "electron";

// A deliberate native application menu (app-chrome-conventions: not the toolkit
// default). BigMouth's own actions live in the in-window UI; this menu carries
// only the platform essentials — the app/quit menu, the full Edit roles (so
// copy/paste/undo work in text inputs), a View menu (dev reload + devtools in dev
// only, plus zoom and fullscreen), and the standard Window menu.
export function buildApplicationMenu(): Menu {
  const isMac = process.platform === "darwin";
  const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);

  const viewSubmenu: MenuItemConstructorOptions[] = [
    ...((isDev
      ? [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }]
      : []) as MenuItemConstructorOptions[]),
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];

  const template: MenuItemConstructorOptions[] = [
    ...((isMac ? [{ role: "appMenu" }] : []) as MenuItemConstructorOptions[]),
    { role: "editMenu" },
    { label: "View", submenu: viewSubmenu },
    { role: "windowMenu" },
  ];

  return Menu.buildFromTemplate(template);
}

export function installApplicationMenu(): void {
  Menu.setApplicationMenu(buildApplicationMenu());
}
