import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CENTER_MIN, LEFT_MIN, RIGHT_MIN } from "@shared/layout";

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
