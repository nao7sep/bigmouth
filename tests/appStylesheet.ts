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
