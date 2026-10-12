import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CENTER_MIN, LEFT_MIN, RECORDS_DETAIL_MIN_WIDTH, RECORDS_LIST_WIDTH, RIGHT_MIN } from "@shared/layout";

// Load the stylesheet into jsdom and check the values the browser computes,
// rather than matching the spelling or placement of individual CSS rules.
const css = readFileSync(`${process.cwd()}/src/renderer/src/App.css`, "utf8");
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

// App.css restates the pane minimums as literals, "kept in sync" with
// @shared/layout by comment only — and the window minimum is derived from those
// constants, so a CSS literal drifting upward makes the window draggable narrow
// enough to crush a pane. Computed styles rather than a text match: a later rule
// overriding min-width would beat one that merely appears in the file.
describe("App.css pane minimums match the shared layout", () => {
  function minWidthOf(className: string): number {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const pane = document.createElement("div");
    pane.className = className;
    document.body.appendChild(pane);

    const value = getComputedStyle(pane).minWidth;
    pane.remove();
    style.remove();
    return Number.parseFloat(value);
  }

  it.each([
    ["pane-left", LEFT_MIN],
    ["pane-center", CENTER_MIN],
    ["pane-right", RIGHT_MIN],
    ["records-list-pane", RECORDS_LIST_WIDTH.min],
    ["records-detail-pane", RECORDS_DETAIL_MIN_WIDTH],
  ])("%s uses the shared minimum", (className, expected) => {
    expect(minWidthOf(className)).toBe(expected);
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
  const namesOne = (selector: string) => FILLED.some((role) => selector.includes(`.${role}`));

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
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.replace(/\/\*[\s\S]*?\*\//g, "").trim(),
    body,
  }));

  it("cuts text only at the reviewed sites", () => {
    const cut = rules.filter((rule) => /text-overflow:\s*ellipsis/.test(rule.body)).map((rule) => rule.selector);
    // Sidebar titles: the selected post's Metadata shows the whole title (or its
    // body, for an untitled post). Menu labels and the workspace header: cut only
    // past the window's width; Workspaces shows the whole name.
    expect(cut).toEqual([".post-item-title", ".menu-item", ".menu-label"]);
  });

  it("never clips a single line without its marker", () => {
    const clipped = rules
      .filter((rule) => /white-space:\s*nowrap/.test(rule.body) && /overflow(-x)?:\s*(hidden|clip)/.test(rule.body))
      .filter((rule) => !/text-overflow:\s*ellipsis/.test(rule.body))
      .map((rule) => rule.selector);
    expect(clipped).toEqual([".bm-visually-hidden"]);
  });
});
