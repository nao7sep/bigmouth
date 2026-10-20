import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CENTER_MIN,
  DIVIDER,
  LEFT_MIN,
  RECORDS_DETAIL_MIN_WIDTH,
  RECORDS_FILTERS_HEIGHT,
  RECORDS_LIST_WIDTH,
  RIGHT_MIN,
} from "@shared/layout";
import { RecordsWindow } from "@renderer/records/RecordsWindow";
import { appCss as css, selectorsOf, styleRules, themeTokens } from "../appStylesheet";

// Load the stylesheet into jsdom and check the values the browser computes,
// rather than matching the spelling or placement of individual CSS rules.
// A computed-style check rather than a text match: the question is what the user
// actually gets, and a `cursor: pointer` declared later would beat a rule that
// merely appears in the file.
describe("App.css disabled cursors", () => {
  function cursorOf(className: string, disabled: boolean): string {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const button = document.createElement("button");
    button.className = className;
    if (disabled) button.disabled = true;
    document.body.appendChild(button);

    const cursor = getComputedStyle(button).cursor;
    button.remove();
    style.remove();
    return cursor;
  }

  // Every one of these kept the hand while dead, because the reset was written
  // per button class in six places and these were not among them.
  it.each(["btn-toolbar", "btn-action", "asset-btn", "meta-field-copy", "btn-primary", "action-button"])(
    "%s shows the arrow when disabled",
    (className) => {
      expect(cursorOf(className, true)).toBe("default");
    },
  );

  it("still shows the hand when enabled", () => {
    expect(cursorOf("btn-toolbar", false)).toBe("pointer");
  });
});

// App.css restates the shared pane geometry as literals because CSS cannot
// import it, and the window minimum is derived from the shared constants, so a
// CSS literal drifting upward makes the window draggable narrow enough to crush
// a pane. These compare each literal with its constant. Computed styles rather
// than a text match: a later rule overriding min-width would beat one that
// merely appears in the file.
describe("App.css pane minimums match the shared layout", () => {
  function computedPx(className: string, property: "minWidth" | "width"): number {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const pane = document.createElement("div");
    pane.className = className;
    document.body.appendChild(pane);

    const value = getComputedStyle(pane)[property];
    pane.remove();
    style.remove();
    return Number.parseFloat(value);
  }

  it.each([
    ["pane-left", LEFT_MIN],
    ["pane-center", CENTER_MIN],
    // The no-post layout, center and right merged, keeps the center's minimum.
    ["pane-empty", CENTER_MIN],
    ["pane-right", RIGHT_MIN],
    ["records-list-pane", RECORDS_LIST_WIDTH.min],
    ["records-detail-pane", RECORDS_DETAIL_MIN_WIDTH],
  ])("%s uses the shared minimum", (className, expected) => {
    expect(computedPx(className, "minWidth")).toBe(expected);
  });

  it("draws the divider at the shared width", () => {
    expect(computedPx("pane-divider", "width")).toBe(DIVIDER);
  });
});

// The records window's minimum height adds the filter band's height, which the
// shared layout states as a sum because the main process sizes the window before
// any page lays out. The band is whatever rows the records window renders into
// it, each one control high, between the band's padding and above its bottom
// line; jsdom lays nothing out, so this sums those parts from the stylesheet.
describe("App.css records filter band matches the shared layout", () => {
  // jsdom computes a var() reference as written; resolve it against the
  // custom properties the element inherits.
  function resolveVars(element: Element, value: string): string {
    const computed = getComputedStyle(element);
    return value.replace(/var\((--[\w-]+)\)/g, (_reference, name: string) => computed.getPropertyValue(name).trim());
  }
  const px = (value: string) => {
    expect(value, "a length in px").toMatch(/^\d+(\.\d+)?px$/);
    return Number.parseFloat(value);
  };

  it("adds up to RECORDS_FILTERS_HEIGHT", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(RecordsWindow, { initialListWidth: RECORDS_LIST_WIDTH.default }));
    document.body.appendChild(host);
    try {
      const band = host.querySelector(".records-filters")!;
      const rows = [...band.children];
      expect(rows.length).toBeGreaterThan(0);
      const rowHeights = rows.map((row) => {
        const controls = row.matches("input, select") ? [row] : [...row.querySelectorAll("input, select")];
        expect(controls.length, `${row.className} holds the controls that set its height`).toBeGreaterThan(0);
        return Math.max(...controls.map((control) => px(resolveVars(control, getComputedStyle(control).height))));
      });

      const computed = getComputedStyle(band);
      // `gap` is row-gap first; jsdom does not expand the shorthand.
      const rowGap = px(computed.getPropertyValue("gap").trim().split(/\s+/)[0]!);
      // jsdom drops a border shorthand holding a var(), so the declared line is
      // resolved and handed back to it to read the width.
      const declaredLine = styleRules
        .filter((rule) => selectorsOf(rule).includes(".records-filters"))
        .map((rule) => rule.style.getPropertyValue("border-bottom"))
        .filter((value) => value !== "")
        .at(-1) ?? "";
      const probe = document.createElement("div");
      probe.style.borderBottom = resolveVars(band, declaredLine);
      const line = px(probe.style.borderBottomWidth);

      const height = px(computed.paddingTop) + px(computed.paddingBottom)
        + rowHeights.reduce((sum, rowHeight) => sum + rowHeight, 0)
        + rowGap * (rows.length - 1)
        + line;
      expect(height).toBe(RECORDS_FILTERS_HEIGHT);
    } finally {
      host.remove();
      style.remove();
    }
  });
});

// The select chevron is an SVG in a data URI, which cannot read a custom
// property, so each theme spells its stroke out; it is that theme's muted ink.
describe("App.css select chevron", () => {
  function chevronStroke(value: string | undefined): string | null {
    expect(value, "--bm-select-chevron must be a url()").toMatch(/^url\(.*\)$/s);
    let url = value!.slice("url(".length, -1).trim();
    if (/^["']/.test(url)) url = url.slice(1, -1);
    // Undo the CSS escapes the CSSOM serializes an unquoted url() with.
    url = url.replace(/\\([0-9a-f]{1,6}\s?|[\s\S])/gi, (_escape, escaped: string) =>
      /^[0-9a-f]/i.test(escaped) && escaped.trim().length > 0
        ? String.fromCodePoint(Number.parseInt(escaped.trim(), 16))
        : escaped);
    const prefix = "data:image/svg+xml,";
    expect(url.startsWith(prefix), "the chevron is a URL-encoded SVG").toBe(true);
    const svg = new DOMParser().parseFromString(decodeURIComponent(url.slice(prefix.length)), "image/svg+xml");
    return svg.querySelector("path")?.getAttribute("stroke") ?? null;
  }

  it.each(["light", "dark"] as const)("strokes the %s chevron in that theme's --bm-text-muted", (theme) => {
    const tokens = themeTokens[theme];
    expect(chevronStroke(tokens.get("--bm-select-chevron"))?.toLowerCase()).toBe(tokens.get("--bm-text-muted")?.toLowerCase());
  });
});

// A state a control does not state for itself is answered by the browser — or,
// where an app rule already pinned that control's fill, not answered at all.
// Neither shows in the resting stylesheet, and jsdom cannot resolve var() to a
// colour, so these read the rules themselves.
describe("App.css button states", () => {
  const sheet = (() => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    const rules = [...(style.sheet!.cssRules as unknown as CSSStyleRule[])]
      .filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE)
      .map((rule, order) => ({ order, selector: rule.selectorText, style: rule.style }));
    style.remove();
    return rules;
  })();

  // The buttons that carry a surface of their own. The quiet controls — the menu
  // items, the hamburger, the modal close, the load-more row — are left out on
  // purpose: they have no fill to step, and they all behave alike.
  const FILLED = [
    "btn-primary", "action-button", "btn-action", "btn-toolbar", "asset-btn",
    "meta-field-copy", "meta-field-generate", "btn-generate-all",
    "btn-delete", "asset-btn-delete", "btn-delete-confirm", "btn-new-post-icon",
  ];
  // Whole class names, so `.btn-delete-confirm` does not also count as `.btn-delete`.
  const classesIn = (selector: string) => [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(([, name]) => name!);
  const namesOne = (selector: string) => classesIn(selector).some((name) => FILLED.includes(name));

  // The list is kept by hand, so a renamed or removed button must not linger in it.
  it("lists only classes the stylesheet styles", () => {
    const classes = new Set(styleRules.flatMap((rule) => classesIn(rule.selectorText)));
    expect(FILLED.filter((role) => !classes.has(role))).toEqual([]);
  });

  // A pointer that is down is also over the control, so a pressed rule only ever
  // shows if it beats the hover rule for the same button. Spelling it the same
  // way, one pseudo-class apart, is what guarantees that: same specificity, and
  // later in the file. `.btn-delete-confirm` had no pressed rule at all, so the
  // button that commits a deletion looked the same pressed as hovered.
  it("gives every filled button a pressed rule that beats its own hover rule", () => {
    const hovers = sheet.filter((rule) => rule.selector.includes(":hover") && namesOne(rule.selector));
    expect(hovers.length).toBeGreaterThan(0);
    for (const hover of hovers) {
      const mirrored = hover.selector.replaceAll(":hover", ":active");
      const pressed = sheet.find((rule) => rule.selector === mirrored);
      expect(pressed, `${hover.selector} has no matching ${mirrored}`).toBeDefined();
      expect(pressed!.order, `${mirrored} must come after the hover rule it beats`)
        .toBeGreaterThan(hover.order);
    }
  });

  // Off, a button is its resting self faded: same fill, outline, ink and
  // footprint, so it stays the control it will be again and the roles stay told
  // apart while they are off. The accent button used to swap its fill for a pale
  // tan instead, which left its near-white label at 1.87:1 in the light theme.
  it("lets a disabled button keep its own fill, outline and ink", () => {
    const fades = ["opacity", "box-shadow", "cursor"];
    for (const rule of sheet) {
      // `:not(:disabled)` names the state it excludes, not the state it styles.
      const targetsDisabled = rule.selector.replaceAll(":not(:disabled)", "").includes(":disabled");
      if (!targetsDisabled || !namesOne(rule.selector)) continue;
      const declared = [...(rule.style as unknown as string[])];
      const restated = declared.filter((property) => !fades.includes(property));
      expect(restated, `${rule.selector} may only recede, not restate ${restated.join(", ")}`)
        .toEqual([]);
    }
  });
});

// The keyboard ring on a selected segment sits on the accent fill, and in the
// light theme the ordinary ring colour equals that fill, so it vanished.
describe("App.css focus ring on a selected segment", () => {
  function ruleFor(selector: string): string {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    try {
      const rules = Array.from(style.sheet!.cssRules) as CSSStyleRule[];
      const rule = rules.find((candidate) => candidate.selectorText?.split(",").map((part) => part.trim()).includes(selector));
      return rule?.style.getPropertyValue("outline-color") ?? "";
    } finally {
      style.remove();
    }
  }

  it.each([".status-radio.active:focus-visible", ".export-format-radio.active:has(input:focus-visible)"])(
    "%s draws its ring in the fill's own ink",
    (selector) => {
      expect(ruleFor(selector)).toBe("var(--bm-on-accent)");
    },
  );
});

// Independent hover, keyboard target and committed selection. jsdom cannot
// drive pointer hover or Chromium's keyboard modality: map those pseudo-classes
// to equal-specificity attributes and let its CSS engine compute combined states.
describe("App.css selection, focus and hover", () => {
  function rules(): CSSStyleRule[] {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    try {
      return Array.from(style.sheet!.cssRules) as CSSStyleRule[];
    } finally {
      style.remove();
    }
  }
  const selectors = (rule: CSSStyleRule) => rule.selectorText?.split(",").map((part) => part.trim()) ?? [];
  const ruleFor = (selector: string) => rules().find((rule) => selectors(rule).includes(selector));

  function stateStyle(className: string, { selected = false, hover = false, keyboard = false, parent = "" } = {}) {
    const style = document.createElement("style");
    style.textContent = css.replace(/:(hover|focus-visible|focus)(?![\w-])/g, (_match, state: string) => `[data-test-${state}]`);
    const host = document.createElement("div");
    host.className = parent;
    if (keyboard) host.setAttribute("data-test-focus-visible", "");
    const item = document.createElement("button");
    item.className = `${className}${selected ? " active selected" : ""}`;
    item.setAttribute("aria-selected", String(selected));
    if (hover) item.setAttribute("data-test-hover", "");
    if (keyboard) {
      item.setAttribute("data-test-focus-visible", "");
      item.setAttribute("data-test-focus", "");
    }
    host.appendChild(item);
    document.head.appendChild(style);
    document.body.appendChild(host);
    try {
      const computed = getComputedStyle(item);
      return { background: computed.background, color: computed.color, outline: computed.outline };
    } finally {
      host.remove();
      style.remove();
    }
  }

  it.each(["right-tab", "settings-tab"])("%s keeps open-panel ink and underline while keyboard fill beats hover without a ring", (className) => {
    const hover = stateStyle(className, { hover: true });
    const keyboard = stateStyle(className, { keyboard: true });
    expect(hover.background).toBe("var(--bm-control-hover)");
    expect(keyboard.background).toBe("var(--bm-control-pressed)");
    expect(keyboard.outline).toBe("none");
    for (const over of [false, true]) {
      const selected = stateStyle(className, { selected: true, hover: over });
      expect(selected.color).toBe("var(--bm-accent-fg)");
      const both = stateStyle(className, { selected: true, hover: over, keyboard: true });
      expect(both.color).toBe(selected.color);
      expect(both.background).toBe(keyboard.background);
      expect(both.outline).toBe("none");
    }
    expect(ruleFor(`.${className}.active::after`)?.style.getPropertyValue("background")).toBe("var(--bm-accent-fg)");
  });

  it("keeps a pointer-opened menu quiet and its keyboard fill distinct from independent hover", () => {
    const quiet = stateStyle("menu-item", { keyboard: true, parent: "menu-popup" });
    const hover = stateStyle("menu-item", { hover: true, parent: "menu-popup" });
    const keyboard = stateStyle("menu-item", { keyboard: true, parent: "menu-popup keyboard-navigation" });
    expect(quiet.background).not.toBe(keyboard.background);
    expect(quiet.outline).toBe("none");
    expect(hover.background).toBe("var(--bm-control-hover)");
    expect(keyboard.background).toBe("var(--bm-control-pressed)");
    expect(stateStyle("menu-item", { hover: true, keyboard: true, parent: "menu-popup keyboard-navigation" }).background).toBe(keyboard.background);
  });

  it.each(["post-picker-item", "workspace-item", "post-item"])("%s preserves its selected appearance under hover and retains a separate keyboard indicator", (className) => {
    const parent = className === "post-picker-item" ? "post-picker-list" : className === "workspace-item" ? "workspace-list" : "left-sections";
    const selected = stateStyle(className, { selected: true, parent });
    const hovered = stateStyle(className, { selected: true, hover: true, parent });
    const focused = stateStyle(className, { selected: true, hover: true, keyboard: true, parent });
    expect(hovered.background).toBe(selected.background);
    expect(focused.background).toBe(selected.background);
    expect(focused.outline).toBe("2px solid var(--bm-accent-fg)");
  });

  it("keeps workspace hover quieter than the open workspace", () => {
    expect(ruleFor(".workspace-item:hover")?.style.getPropertyValue("border-color")).toBe("");
    expect(ruleFor('.workspace-item[aria-selected="true"]')?.style.getPropertyValue("border-color")).toBe("var(--bm-accent-fg)");
  });
});

// Truncation is a bounded exception inventory (text-cleanup-conventions rule 4):
// each listed site shows its marker and keeps a keyboard path to the whole value.
// A new cut must be justified and added here, or the text wraps.
describe("App.css truncation sites", () => {
  // Every style rule, those inside @media included, as its selector list and what it declares.
  const rules = styleRules.map((rule) => ({
    selector: selectorsOf(rule).join(", "),
    declares: (property: string) => rule.style.getPropertyValue(property),
  }));
  // The overflow on one axis: its own longhand, else the `overflow` shorthand's
  // value for it (x first, y last).
  const overflowOn = (rule: (typeof rules)[number], axis: "x" | "y") => {
    const shorthand = rule.declares("overflow").split(/\s+/);
    return rule.declares(`overflow-${axis}`) || (axis === "x" ? shorthand[0]! : shorthand.at(-1)!);
  };
  const ellipsizes = (rule: (typeof rules)[number]) => rule.declares("text-overflow") === "ellipsis";

  it("cuts text only at the reviewed sites", () => {
    const cut = rules.filter(ellipsizes).map((rule) => rule.selector);
    // Each site, and where its whole value is reached:
    expect(cut).toEqual([
      // Sidebar titles: the selected post's Metadata shows the whole title (or
      // its body, for an untitled post).
      ".post-item-title",
      // Sidebar and toolbar target names: Settings' Targets tab shows them whole.
      ".post-item-target",
      ".toolbar-target",
      // A path's head, then its final segment (ShortPath): its tooltip shows
      // the whole path.
      ".short-path-head",
      ".short-path-tail",
      // Menu labels and the workspace header: cut only past the window's width;
      // Workspaces and Settings show the whole name.
      ".menu-item-text",
      ".menu-label",
      // A closed select: opening it shows every option whole.
      "select:is(.form-select, .prompt-select)",
      // Picker rows and New Post's linked source: linking or opening the post
      // shows its whole title in Metadata; Settings shows the target names.
      ".post-picker-title",
      ".post-picker-sub",
      ".source-selected-title",
      // Workspace rows: the tooltip and Rename's field show the whole name.
      ".workspace-item-name-text",
      // Records rows: the selected record's detail shows the whole message.
      ".records-row-title",
      ".records-row-text",
    ]);
  });

  // Several lines, then an ellipsis: the same inventory for -webkit-line-clamp.
  it("clamps lines only at the reviewed sites", () => {
    const clamped = rules
      .filter((rule) => !["", "none"].includes(rule.declares("-webkit-line-clamp")))
      .map((rule) => rule.selector);
    // An asset's name beside its thumbnail: its tooltip shows it whole.
    expect(clamped).toEqual([".asset-name"]);
    for (const rule of rules.filter((candidate) => clamped.includes(candidate.selector))) {
      expect(overflowOn(rule, "y"), `${rule.selector} must hide what it clamps`).toBe("hidden");
    }
  });

  // A flex or grid container cuts its text but draws no "…", which once left
  // menu commands clipped with no marker.
  it("marks a cut on a box that can draw the ellipsis", () => {
    const flexCut = rules
      .filter((rule) => ellipsizes(rule) && ["flex", "inline-flex", "grid", "inline-grid"].includes(rule.declares("display")))
      .map((rule) => rule.selector);
    expect(flexCut).toEqual([]);
  });

  it("never clips a single line without its marker", () => {
    const clipped = rules
      .filter((rule) => rule.declares("white-space") === "nowrap" && ["hidden", "clip"].includes(overflowOn(rule, "x")))
      .filter((rule) => !ellipsizes(rule))
      .map((rule) => rule.selector);
    expect(clipped).toEqual([".bm-visually-hidden"]);
  });
});

// A right-pane panel root that sets its own display (.assets-tab is a flex
// column, declared later in the file) once outranked .tab-hidden, leaving the
// Assets toolbar showing beneath every other tab.
describe("App.css hidden right-pane panels", () => {
  it("hides a panel whose root sets its own display", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const pane = document.createElement("div");
    pane.className = "right-content";
    const panel = document.createElement("div");
    panel.setAttribute("role", "tabpanel");
    panel.className = "assets-tab tab-hidden";
    pane.appendChild(panel);
    document.body.appendChild(pane);

    const display = getComputedStyle(panel).display;
    pane.remove();
    style.remove();
    expect(display).toBe("none");
  });
});

// Accent means "do this": the unlocked post's Lock carries it, and the locked
// post's Locked is the plain fill, so the colour never reads as the state.
describe("App.css lock toggle", () => {
  // jsdom does not resolve custom properties, so this reads the declared value.
  function backgroundOf(pressed: boolean): string {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    const button = document.createElement("button");
    button.className = "btn-toolbar btn-lock";
    button.setAttribute("aria-pressed", String(pressed));
    document.body.appendChild(button);
    const background = getComputedStyle(button).getPropertyValue("background");
    button.remove();
    style.remove();
    return background;
  }

  it("fills Lock with the accent and leaves Locked plain", () => {
    expect(backgroundOf(false)).toBe("var(--bm-accent)");
    expect(backgroundOf(true)).toBe("var(--bm-control-bg)");
  });
});

// A menu stays narrow rather than stretching toward the window's edge
// (composite-control-conventions); jsdom cannot measure labels, so this checks
// the declared cap.
describe("App.css menu width", () => {
  it("caps the menu at a narrow width as well as the window's", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    const popup = document.createElement("div");
    popup.className = "menu-popup";
    document.body.appendChild(popup);
    const maxWidth = getComputedStyle(popup).maxWidth;
    popup.remove();
    style.remove();
    // 20rem in jsdom's wide default window.
    expect(maxWidth).toBe("320px");
  });
});
