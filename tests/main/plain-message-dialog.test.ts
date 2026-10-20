import { beforeAll, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";

const electron = vi.hoisted(() => {
  const created: Array<Record<string, unknown>> = [];
  class BrowserWindow {
    static getFocusedWindow = () => null;
    webContents = { on: () => undefined, once: () => undefined };
    constructor(options: Record<string, unknown>) {
      created.push(options);
    }
    on = () => undefined;
    // Never settles: the test reads the window's options, not the dialog's answer.
    loadURL = () => new Promise<void>(() => undefined);
  }
  return { created, BrowserWindow, nativeTheme: { shouldUseDarkColors: false } };
});

vi.mock("electron", () => ({
  BrowserWindow: electron.BrowserWindow,
  nativeTheme: electron.nativeTheme,
  systemPreferences: {},
}));

import { renderPlainMessageDialogHtml, showPlainMessageDialog } from "@main/plain-message-dialog";
import { windowBackground } from "@main/theme";
import { createTranslator } from "@shared/i18n/translate";
import { loadCatalogue } from "@shared/i18n/catalogues";

beforeAll(() => loadCatalogue("ja"));

type State = "rest" | "hover" | "focus";

// The dialog page as a browser would lay it out. jsdom applies no media query, so
// the dark scheme is the page's own `prefers-color-scheme: dark` rules appended
// after everything else, which is where they win in a dark window.
function page(html: string, scheme: "light" | "dark" = "light"): JSDOM {
  const dom = new JSDOM(html);
  if (scheme === "dark") {
    const { document, CSSMediaRule } = dom.window;
    const dark = [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules])
      .filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule)
      .filter((rule) => [...rule.media].some((medium) => medium.replace(/\s/g, "") === "(prefers-color-scheme:dark)"));
    expect(dark.length, "the page has no dark scheme").toBeGreaterThan(0);
    const style = document.createElement("style");
    style.textContent = dark.flatMap((rule) => [...rule.cssRules].map((inner) => inner.cssText)).join("\n");
    document.head.append(style);
  }
  return dom;
}

// jsdom keeps matched styles across a focus or hover change, so each state is read
// from a page of its own. Hover holds only while a pointer event is dispatched.
function background(html: string, selector: string, state: State): string {
  const { window } = page(html);
  const element = window.document.querySelector<HTMLElement>(selector)!;
  if (state === "focus") element.focus();
  if (state !== "hover") return window.getComputedStyle(element).backgroundColor;
  let hovered = "";
  element.addEventListener("mouseover", () => {
    hovered = window.getComputedStyle(element).backgroundColor;
  });
  element.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  return hovered;
}

// A colour as the page's CSSOM writes it, so a hex value compares with a computed one.
function asComputed(color: string): string {
  const probe = new JSDOM("").window.document.createElement("i");
  probe.style.backgroundColor = color;
  return probe.style.backgroundColor;
}

describe("plain message dialog", () => {
  it("keeps header and footer fixed while only the body scrolls", () => {
    const html = renderPlainMessageDialogHtml({ title: "Title", message: "Message", detail: "Detail" }, ["OK"]);
    const { window } = page(html);
    const { document } = window;
    const style = (element: Element) => window.getComputedStyle(element);

    const dialog = document.querySelector(".dialog")!;
    expect([...dialog.children].map((child) => child.id)).toEqual(["dialog-header", "dialog-body", "dialog-footer"]);
    expect(style(dialog).display).toBe("grid");
    // Only the middle row is allowed to shrink below its content.
    expect(style(dialog).gridTemplateRows.split(/\s+(?![^(]*\))/)).toEqual(["auto", "minmax(0,1fr)", "auto"]);

    const body = document.getElementById("dialog-body")!;
    expect(body.getAttribute("role")).toBe("region");
    expect(body.getAttribute("aria-label")).toBe("Message details");
    expect(body.tabIndex).toBe(0);
    expect(style(body).overflow).toBe("auto");
    expect(style(body).minHeight).toBe("0px");
    expect(body.querySelector(".detail")?.textContent).toBe("Detail");

    expect(style(document.body).overflow).toBe("hidden");
    // The page is exactly the window's height, so the page itself never scrolls.
    expect(style(document.body).height).toBe(`${window.innerHeight}px`);
    expect(style(document.body).margin).toBe("0px");
  });

  it("gives its scrollbar a full-size track to grab", () => {
    const html = renderPlainMessageDialogHtml({ title: "T", message: "M" }, ["OK"]);
    const scrollbar = [...page(html).window.document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules])
      .find((rule): rule is CSSStyleRule => "selectorText" in rule && rule.selectorText === "*::-webkit-scrollbar");
    expect(scrollbar?.style.width).toBe("16px");
    expect(scrollbar?.style.height).toBe("16px");
  });

  it("preserves neutral, primary, and destructive intent on hover and focus", () => {
    const html = renderPlainMessageDialogHtml(
      { title: "Choice", message: "Choose", defaultId: 1, destructiveId: 2 },
      ["Cancel", "Continue", "Quit"],
    );
    const { document } = page(html).window;
    expect([...document.querySelectorAll("button")].map((button) => [button.textContent, button.className])).toEqual([
      ["Cancel", "button"],
      ["Continue", "button primary"],
      ["Quit", "button destructive"],
    ]);

    const buttons = ["#choice-0", "#choice-1", "#choice-2"];
    const look = (state: State) => buttons.map((selector) => background(html, selector, state));
    const rest = look("rest");
    const hover = look("hover");
    const focus = look("focus");

    // Each button answers the pointer and the keyboard the same way, visibly…
    expect(hover).toEqual(focus);
    buttons.forEach((_, index) => expect(hover[index]).not.toBe(rest[index]));
    // …and the three intents stay apart in every state.
    for (const state of [rest, hover, focus]) expect(new Set(state).size).toBe(3);
  });

  // Three buttons in a long language outgrow the dialog's narrowest width.
  it("wraps its buttons onto another row rather than clipping them", () => {
    const html = renderPlainMessageDialogHtml({ title: "T", message: "M" }, ["Abbrechen", "Erneut versuchen", "Trotzdem beenden"]);
    const { window } = page(html);
    const footer = window.getComputedStyle(window.document.getElementById("dialog-footer")!);
    expect(footer.display).toBe("flex");
    expect(footer.flexWrap).toBe("wrap");
  });

  it("declares the interface language and names its body region in it", () => {
    const html = renderPlainMessageDialogHtml({ title: "T", message: "M" }, ["OK"], createTranslator("ja"));
    const { document } = page(html).window;
    expect(document.documentElement.lang).toBe("ja");
    expect(document.getElementById("dialog-body")?.getAttribute("aria-label")).toBe("メッセージの詳細");
  });

  // A theme change repaints every window with windowBackground(), this one too,
  // so the page must paint that same colour or the frame shows around it.
  it("paints the app's window background in each scheme, in its frame and its page", () => {
    const html = renderPlainMessageDialogHtml({ title: "T", message: "M" }, ["OK"]);
    for (const dark of [false, true]) {
      const { window } = page(html, dark ? "dark" : "light");
      expect(window.getComputedStyle(window.document.documentElement).backgroundColor).toBe(asComputed(windowBackground(dark)));

      electron.nativeTheme.shouldUseDarkColors = dark;
      void showPlainMessageDialog({ title: "T", message: "M" });
      expect(electron.created.at(-1)?.backgroundColor).toBe(windowBackground(dark));
    }
    expect(windowBackground(false)).not.toBe(windowBackground(true));
  });
});
