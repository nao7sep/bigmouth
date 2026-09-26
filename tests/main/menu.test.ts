import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

vi.mock("electron", () => ({ Menu: {}, app: {}, BrowserWindow: {} }));

import { applicationMenuTemplate } from "@main/menu";
import { createTranslator } from "@shared/i18n/translate";

function labels(items: MenuItemConstructorOptions[]): string[] {
  return items.flatMap((item) => [
    ...(item.label === undefined ? [] : [item.label]),
    ...(Array.isArray(item.submenu) ? labels(item.submenu as MenuItemConstructorOptions[]) : []),
  ]);
}

describe("application menu", () => {
  it("labels every item in the interface language, the Edit menu included", () => {
    const template = applicationMenuTemplate(createTranslator("ja"), "darwin");
    const [appMenu, edit, view, window] = template;
    expect(appMenu).toMatchObject({ role: "appMenu", label: "BigMouth" });
    expect(edit).toMatchObject({ role: "editMenu", label: "編集" });
    expect(view!.label).toBe("表示");
    expect(window).toMatchObject({ role: "windowMenu", label: "ウインドウ" });
    // Every item that has a role also has a label, since Electron's are English.
    const english = labels(applicationMenuTemplate(createTranslator("en"), "darwin"));
    const japanese = labels(template);
    expect(japanese).toHaveLength(english.length);
    expect(japanese.filter((label, index) => label === english[index])).toEqual(["BigMouth"]);
    expect(labels(template).every((label) => label.trim().length > 0)).toBe(true);
  });

  it("names the app in its own items", () => {
    const [appMenu] = applicationMenuTemplate(createTranslator("de"), "darwin");
    expect(labels([appMenu!])).toEqual(
      expect.arrayContaining(["Über BigMouth", "BigMouth ausblenden", "BigMouth beenden"]),
    );
  });

  it("has no app menu off macOS and closes the window from the Window menu", () => {
    const template = applicationMenuTemplate(createTranslator("fr"), "win32");
    expect(template.map((item) => item.role ?? item.label)).toEqual(["editMenu", "Présentation", "windowMenu"]);
    expect(labels([template[2]!])).toEqual(["Fenêtre", "Minimiser", "Fermer"]);
  });
});
