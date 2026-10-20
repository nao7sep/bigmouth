import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

// The app stylesheet as jsdom's CSS engine parses it, for tests whose subject is
// the stylesheet itself. Reading rules and declarations through the CSSOM rather
// than scanning the file's text means comments, whitespace, rule order and
// nesting inside @media are the parser's business, and a test asks only what a
// rule declares. A private jsdom window does the parsing so the same objects are
// available under Node and under the renderer project's jsdom environment.
//
// jsdom keeps custom properties (`--bm-*`) verbatim, `::-webkit-scrollbar`
// selectors, `scrollbar-width`, `scrollbar-gutter`, and data-URI values (it
// re-serializes a url() unquoted, with CSS escapes). It does not expand `gap` or
// a `border-*` shorthand that holds a var() into longhands, so read those by the
// shorthand's own name.

export const appCss = readFileSync(resolve("src/renderer/src/App.css"), "utf8");

const { window } = new JSDOM("<!doctype html><style></style>");
const element = window.document.querySelector("style")!;
element.textContent = appCss;
const topLevel = [...element.sheet!.cssRules];

// jsdom implements CSSGroupingRule (the base of @media, @supports and the
// like) but its window typings leave it untyped.
const GroupingRule: typeof CSSGroupingRule = window.CSSGroupingRule;

function styleRulesIn(rules: Iterable<CSSRule>): CSSStyleRule[] {
  return [...rules].flatMap((rule) => {
    if (rule instanceof window.CSSStyleRule) return [rule];
    if (rule instanceof GroupingRule) return styleRulesIn(rule.cssRules);
    return [];
  });
}

/** Every style rule in source order, those nested in @media and other grouping rules included. */
export const styleRules: readonly CSSStyleRule[] = styleRulesIn(topLevel);

/** The style rules outside any @media or other grouping rule, in source order. */
export const topLevelStyleRules: readonly CSSStyleRule[] = topLevel.filter(
  (rule): rule is CSSStyleRule => rule instanceof window.CSSStyleRule,
);

/** A rule's selector list, split at its top-level commas so `:is(.a, .b)` stays whole. */
export function selectorsOf(rule: CSSStyleRule): string[] {
  const selectors: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of rule.selectorText) {
    if (character === "(" || character === "[") depth += 1;
    if (character === ")" || character === "]") depth -= 1;
    if (character === "," && depth === 0) {
      selectors.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  selectors.push(current.trim());
  return selectors;
}

/**
 * What the top-level rules naming `selector` in their selector list declare for
 * `property`, the last declaration winning as it does in the cascade; "" when none does.
 */
export function topLevelDeclaration(selector: string, property: string): string {
  return topLevelStyleRules
    .filter((rule) => selectorsOf(rule).includes(selector))
    .map((rule) => rule.style.getPropertyValue(property))
    .filter((value) => value !== "")
    .at(-1) ?? "";
}

function customProperties(rule: CSSStyleRule): ReadonlyMap<string, string> {
  const declared = [...(rule.style as unknown as Iterable<string>)];
  return new Map(
    declared
      .filter((property) => property.startsWith("--"))
      .map((property) => [property, rule.style.getPropertyValue(property).trim()]),
  );
}

function onlyRootRule(rules: Iterable<CSSRule>, where: string): CSSStyleRule {
  const roots = [...rules].filter(
    (rule): rule is CSSStyleRule => rule instanceof window.CSSStyleRule && rule.selectorText === ":root",
  );
  if (roots.length !== 1) throw new Error(`expected one :root rule ${where}, found ${roots.length}`);
  return roots[0]!;
}

function darkThemeRules(): CSSRuleList {
  const media = topLevel.filter(
    (rule): rule is CSSMediaRule =>
      rule instanceof window.CSSMediaRule && rule.media.mediaText === "(prefers-color-scheme: dark)",
  );
  if (media.length !== 1) throw new Error(`expected one prefers-color-scheme: dark block, found ${media.length}`);
  return media[0]!.cssRules;
}

/** The light theme: the custom properties of the top-level `:root` rule. */
export const lightTokens = customProperties(onlyRootRule(topLevel, "at the top level"));

/** The dark theme: the custom properties of the `:root` rule inside `@media (prefers-color-scheme: dark)`. */
export const darkTokens = customProperties(onlyRootRule(darkThemeRules(), "in the dark theme block"));

export const themeTokens = { light: lightTokens, dark: darkTokens } as const;

/** An interaction to put a document in before reading a computed style. */
export interface Interaction {
  /** Moves focus to the element this selector names. */
  focus?: string;
  /** With `focus`: the focus arrives from the keyboard, a Tab press, so `:focus-visible` matches. */
  keyboard?: boolean;
  /** Puts the pointer over the element this selector names, after any focus. */
  hover?: string;
}

/**
 * The computed style of the element `target` names, in a fresh document holding
 * the app stylesheet and `html`, after `interaction`. The states are real: jsdom's
 * own selector engine matches `:hover`, `:focus` and `:focus-visible` from the
 * events dispatched here, so the cascade decides what wins exactly as written.
 * A fresh document per call keeps one call's events from colouring the next.
 *
 * jsdom reads `:hover` and `:focus-visible` from the most recent pointer or key
 * event, so a hover after a keyboard focus ends `:focus-visible` (`:focus`
 * stays): a state needing both at once is not one this can produce.
 *
 * jsdom substitutes no custom properties, so these checks read the declared
 * `var(--bm-...)` a winning `background` names. package.json holds jsdom at
 * 30.1.2 because 30.1.3 began expanding the `background` shorthand at computed
 * time and returns its initial transparent value whenever the declaration holds
 * a `var()`, so every fill compares equal. Move past it once jsdom either
 * resolves the variable or keeps the declared value again.
 */
export function computedStyleAfter(html: string, target: string, interaction: Interaction = {}): CSSStyleDeclaration {
  const dom = new JSDOM(`<!doctype html><style>${appCss}</style><body>${html}</body>`);
  const { document } = dom.window;
  const find = (selector: string) => {
    const element = document.querySelector<HTMLElement>(selector);
    if (element === null) throw new Error(`nothing matches ${selector}`);
    return element;
  };
  if (interaction.focus !== undefined) {
    if (interaction.keyboard) {
      document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    }
    find(interaction.focus).focus();
  }
  if (interaction.hover !== undefined) {
    find(interaction.hover).dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
  }
  return dom.window.getComputedStyle(find(target));
}
