// @vitest-environment node
//
// The ring belongs to what the key acts on (composite-control-conventions). A
// container that holds focus on its items' behalf — a list with an active row, a
// scroll region, a modal body — draws no ring of its own, because
// `:focus-visible` is no guard for it: any key pressed after a click turns it on,
// and since Safari 27 so does focus a script moves after keyboard use. The
// analysis and imaging results, the export preview and the message window's body
// all fell back to the browser's own ring that way.
//
// Every place this app makes something focusable is found here in its syntax
// tree, not from memory, and each has to be one of three things: a control or
// item, which may ring; a container the covering rule in App.css reaches; or a
// site listed below with the reason it is neither. A new one that is none of
// these fails. Stylesheets are read through the CSS object model, and whether a
// rule styles a focused container is decided by matching it against one.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const SOURCE_DIR = "src";
const COVERING_STYLESHEET = "src/renderer/src/App.css";

// Focus sites the syntax alone cannot place, and why each is not a ringing
// container. Each entry covers only the one kind of site it explains, so anything
// else added to the same file is still placed on its own merits.
const EXPLAINED: Explained = {};

// A composite that owns its items, or a region that scrolls on their behalf.
const CONTAINER_ROLES = [
  "listbox", "tree", "grid", "treegrid", "region", "tabpanel",
  "dialog", "alertdialog", "document", "log",
  "radiogroup", "tablist", "menu", "menubar", "toolbar",
];
const ITEM_ROLES = [
  "option", "tab", "treeitem", "row", "gridcell", "menuitem", "menuitemradio",
  "menuitemcheckbox", "radio", "checkbox", "switch", "button", "link",
  "separator", "slider", "spinbutton", "textbox", "combobox",
];
const CONTROL_TAGS = ["button", "a", "input", "select", "textarea", "summary"];
const PASSIVE_SCROLL_REGION = "data-passive-scroll-region";

// Class names that hide or draw an outline: Tailwind's two spellings of a hidden
// one (`outline-none`, and v4's `outline-hidden`, which keeps a transparent one
// for forced-colors mode), and its focus ring and outline utilities.
const OUTLINE_OFF_CLASS = /^(focus:|focus-visible:)?outline-(none|hidden)$/;
const CONTAINER_RING_CLASS = /^(focus|focus-visible):(ring|ring-(?!0$)\S+|outline-(?!(none|hidden|0)$)\S+)$/;

// What a focus site says about the element it makes focusable.
type Target = {
  // An intrinsic element's tag; a component's own element is not known here.
  tag?: string;
  role?: string;
  classes: string[];
  attributes: string[];
  inlineOutlineOff: boolean;
};
type Site = { file: string; line: number; kind: "attribute" | "object" | "dom"; target: Target };
type Scan = { file: string; sites: Site[]; styles: string[] };
type Explained = Record<string, { kind: Site["kind"]; reason: string }>;
type Placement = "control" | "covered" | "suppressed" | "explained";

// ---------------------------------------------------------------- source scan

type AstNode = { type: string; loc?: { start: { line: number } }; [key: string]: unknown };

const NOT_CHILDREN = new Set(["loc", "start", "end", "extra", "leadingComments", "trailingComments", "innerComments"]);

function isNode(value: unknown): value is AstNode {
  return value !== null && typeof value === "object" && typeof (value as AstNode).type === "string";
}

function walk(node: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isNode(node)) return;
  visit(node);
  for (const [key, child] of Object.entries(node)) if (!NOT_CHILDREN.has(key)) walk(child, visit);
}

function lineOf(node: AstNode): number {
  return node.loc?.start.line ?? 0;
}

// A literal's text as an HTML parser would receive it; a template's
// substitutions are left out.
function literalText(node: AstNode): string | undefined {
  if (node.type === "StringLiteral") return node.value as string;
  if (node.type === "TemplateLiteral") {
    return (node.quasis as Array<{ value: { cooked: string } }>).map((quasi) => quasi.value.cooked).join("");
  }
  return undefined;
}

// The one value an attribute or property always has, if it is written as a literal.
function staticString(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === "JSXExpressionContainer") return staticString(node.expression);
  if (node.type === "TemplateLiteral" && (node.expressions as unknown[]).length > 0) return undefined;
  return literalText(node);
}

// Every class name an expression can produce, a conditional's branches included.
function classTokens(node: unknown): string[] {
  const tokens: string[] = [];
  walk(node, (current) => {
    const text =
      current.type === "StringLiteral" ? (current.value as string)
      : current.type === "TemplateElement" ? (current.value as { cooked: string }).cooked
      : undefined;
    if (text) tokens.push(...text.split(/\s+/).filter(Boolean));
  });
  return tokens;
}

// An inline style object that switches the outline off.
function inlineOutlineOff(node: unknown): boolean {
  const style = isNode(node) && node.type === "JSXExpressionContainer" ? node.expression : node;
  if (!isNode(style) || style.type !== "ObjectExpression") return false;
  return [...properties(style)].some(
    ([name, value]) => ["outline", "outlineStyle"].includes(name) && staticString(value)?.trim().split(/\s+/)[0] === "none",
  );
}

function keyName(node: AstNode): string | undefined {
  if (node.computed) return undefined;
  const key = node.key as AstNode;
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "StringLiteral") return key.value as string;
  return undefined;
}

function properties(object: AstNode): Map<string, AstNode> {
  const found = new Map<string, AstNode>();
  for (const property of object.properties as AstNode[]) {
    const name = property.type === "ObjectProperty" ? keyName(property) : undefined;
    if (name !== undefined) found.set(name, property.value as AstNode);
  }
  return found;
}

function isTabIndex(name: string | undefined): boolean {
  return name?.toLowerCase() === "tabindex";
}

function jsxTarget(element: AstNode): Target {
  const name = element.name as AstNode;
  const attributes = new Map<string, AstNode | null>();
  for (const attribute of element.attributes as AstNode[]) {
    const id = attribute.name as AstNode | undefined;
    if (attribute.type === "JSXAttribute" && id?.type === "JSXIdentifier") {
      attributes.set(id.name as string, attribute.value as AstNode | null);
    }
  }
  return {
    // JSX treats a lower-case name as the element itself, any other as a component.
    tag: name.type === "JSXIdentifier" && /^[a-z]/.test(name.name as string) ? (name.name as string) : undefined,
    role: staticString(attributes.get("role")),
    classes: classTokens(attributes.get("className") ?? attributes.get("class")),
    attributes: [...attributes.keys()],
    inlineOutlineOff: inlineOutlineOff(attributes.get("style")),
  };
}

function objectTarget(object: AstNode): Target {
  const props = properties(object);
  return {
    role: staticString(props.get("role")),
    classes: classTokens(props.get("className")),
    attributes: [...props.keys()],
    inlineOutlineOff: inlineOutlineOff(props.get("style")),
  };
}

function htmlTarget(element: Element): Target {
  const style = (element as HTMLElement).style;
  return {
    tag: element.localName,
    role: element.getAttribute("role") ?? undefined,
    classes: [...element.classList],
    attributes: element.getAttributeNames(),
    inlineOutlineOff: ["outline", "outline-style"].some(
      (property) => style?.getPropertyValue(property).trim().split(/\s+/)[0] === "none",
    ),
  };
}

const htmlDocument = new JSDOM("").window.document;

// A page the main process writes out as a string never loads the app's
// stylesheet; whatever elements and <style> it carries are found by parsing it.
function htmlIn(text: string): DocumentFragment {
  const template = htmlDocument.createElement("template");
  template.innerHTML = text;
  return template.content;
}

function scanScript(file: string, text: string): Scan {
  // A .ts file may hold `<T>value` casts, which JSX would read as tags.
  const plugins: Array<"jsx" | "typescript"> = file.endsWith(".ts") ? ["typescript"] : ["jsx", "typescript"];
  const ast = parse(text, { sourceType: "module", plugins });
  const sites: Site[] = [];
  const styles: string[] = [];
  walk(ast.program, (node) => {
    if (node.type === "JSXOpeningElement") {
      for (const attribute of node.attributes as AstNode[]) {
        const id = attribute.name as AstNode | undefined;
        if (attribute.type === "JSXAttribute" && id?.type === "JSXIdentifier" && isTabIndex(id.name as string)) {
          sites.push({ file, line: lineOf(attribute), kind: "attribute", target: jsxTarget(node) });
        }
      }
    } else if (node.type === "ObjectExpression") {
      for (const property of node.properties as AstNode[]) {
        if (property.type === "ObjectProperty" && isTabIndex(keyName(property))) {
          sites.push({ file, line: lineOf(property), kind: "object", target: objectTarget(node) });
        }
      }
    } else if (node.type === "AssignmentExpression") {
      const left = node.left as AstNode;
      if (left.type === "MemberExpression" && !left.computed && isTabIndex((left.property as AstNode).name as string)) {
        sites.push({ file, line: lineOf(node), kind: "dom", target: { classes: [], attributes: [], inlineOutlineOff: false } });
      }
    } else if (node.type === "CallExpression") {
      const callee = node.callee as AstNode;
      const [name] = node.arguments as AstNode[];
      if (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        (callee.property as AstNode).name === "setAttribute" &&
        name &&
        isTabIndex(staticString(name))
      ) {
        sites.push({ file, line: lineOf(node), kind: "dom", target: { classes: [], attributes: [], inlineOutlineOff: false } });
      }
    } else {
      const text = literalText(node);
      if (text === undefined) return;
      const page = htmlIn(text);
      for (const element of page.querySelectorAll("[tabindex]")) {
        sites.push({ file, line: lineOf(node), kind: "attribute", target: htmlTarget(element) });
      }
      for (const style of page.querySelectorAll("style")) styles.push(style.textContent ?? "");
    }
  });
  return { file, sites: sites.sort((a, b) => a.line - b.line), styles };
}

function scanHtml(file: string, text: string): Scan {
  const dom = new JSDOM(text, { includeNodeLocations: true });
  const { document } = dom.window;
  return {
    file,
    sites: [...document.querySelectorAll("[tabindex]")].map((element) => ({
      file,
      line: dom.nodeLocation(element)?.startLine ?? 0,
      kind: "attribute" as const,
      target: htmlTarget(element),
    })),
    styles: [...document.querySelectorAll("style")].map((style) => style.textContent ?? ""),
  };
}

function scanFile(file: string, text: string): Scan {
  return file.endsWith(".html") ? scanHtml(file, text) : scanScript(file, text);
}

function filesUnder(dir: string, wanted: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path, wanted);
    return wanted(name) ? [path] : [];
  });
}

// ---------------------------------------------------------------- stylesheets

type Rule = { selector: string; style: CSSStyleDeclaration; layered: boolean };

const cssWindow = new JSDOM("").window;

function cssRules(css: string): Rule[] {
  const element = cssWindow.document.createElement("style");
  element.textContent = css;
  cssWindow.document.head.append(element);
  const rules = flatten(element.sheet!.cssRules, false);
  element.remove();
  return rules;
}

function flatten(list: CSSRuleList, layered: boolean): Rule[] {
  return [...list].flatMap((rule): Rule[] => {
    if (rule instanceof cssWindow.CSSStyleRule) return [{ selector: rule.selectorText, style: rule.style, layered }];
    if (rule instanceof cssWindow.CSSGroupingRule) {
      return flatten((rule as CSSGroupingRule).cssRules, layered || rule instanceof cssWindow.CSSLayerBlockRule);
    }
    return [];
  });
}

// The element each selector in a list actually styles: its last compound, after
// any combinator. Focus on a container may still paint its active row —
// `[role="listbox"]:focus-visible .row` styles the row — so only a selector whose
// subject is itself the focused container counts against it. The CSS object
// model gives a rule's selector only as text, so the list and its combinators are
// split here, outside any brackets or parentheses.
function subjects(selector: string): string[] {
  const list: string[] = [];
  let depth = 0;
  let current = "";
  for (const c of selector) {
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) {
      list.push(current);
      current = "";
    } else current += c;
  }
  list.push(current);
  return list.map((part) => {
    const s = part.trim();
    let level = 0;
    let last = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charAt(i);
      if (c === "(" || c === "[") level++;
      else if (c === ")" || c === "]") level--;
      else if (level === 0 && /[\s>+~]/.test(c)) last = i + 1;
    }
    return s.slice(last).trim();
  });
}

const probeDocument = new JSDOM("<!doctype html><body></body>").window.document;

// The target as an element on a page, for a selector engine to match.
function probe(target: Target, withClasses: boolean): HTMLElement {
  const element = probeDocument.createElement(target.tag ?? "div");
  for (const name of target.attributes) if (name.startsWith("data-")) element.setAttribute(name, "");
  if (target.role) element.setAttribute("role", target.role);
  if (withClasses && target.classes.length) element.className = target.classes.join(" ");
  element.tabIndex = 0;
  return element;
}

// Whether the rule styles the target itself because it has focus: a subject
// that matches the element once it is focused and not before.
function focusRuleOn(rule: Rule, target: Target, withClasses = true): boolean {
  return focusRulesOn([rule], target, withClasses)[0];
}

// Probe all rules with one focus transition; rebuilding and focusing the same
// element for every rule repeatedly runs jsdom's style and focus machinery.
function focusRulesOn(rules: Rule[], target: Target, withClasses = true): boolean[] {
  const element = probe(target, withClasses);
  probeDocument.body.append(element);
  const parts = rules.map((rule) => subjects(rule.selector));
  const before = parts.map((list) => list.map((part) => element.matches(part)));
  element.focus();
  const after = parts.map((list) => list.map((part) => element.matches(part)));
  element.remove();
  return after.map((list, ruleIndex) => list.some((matched, index) => matched && !before[ruleIndex][index]));
}

function firstValue(style: CSSStyleDeclaration, property: string): string {
  return style.getPropertyValue(property).trim().toLowerCase().split(/\s+/)[0] ?? "";
}

function turnsOutlineOff(style: CSSStyleDeclaration): boolean {
  return firstValue(style, "outline") === "none" || firstValue(style, "outline-style") === "none";
}

// Whether a declaration block paints something around its element: an outline
// that is not switched off, or a box shadow, which is how ring utilities draw.
function draws(style: CSSStyleDeclaration): boolean {
  const outline = firstValue(style, "outline");
  const outlineStyle = firstValue(style, "outline-style");
  const outlineWidth = firstValue(style, "outline-width");
  const shadow = firstValue(style, "box-shadow");
  return (
    (outline !== "" && outline !== "none" && outline !== "0") ||
    (outlineStyle !== "" && outlineStyle !== "none") ||
    (outlineWidth !== "" && !/^0(px)?$/.test(outlineWidth)) ||
    (shadow !== "" && shadow !== "none")
  );
}

// ---------------------------------------------------------------- the checks

// A plain-CSS app turns an outline off by class, in a stylesheet, rather than
// with a utility on the element: a focus rule that switches the outline off and
// reaches the site only through its own classes.
function suppressedByClass(target: Target, rules: Rule[]): boolean {
  return (
    target.classes.length > 0 &&
    rules.some((rule) => turnsOutlineOff(rule.style) && focusRuleOn(rule, target) && !focusRuleOn(rule, target, false))
  );
}

function placementOnMerits(site: Site, rules: Rule[]): Placement | undefined {
  if (site.kind === "dom") return undefined;
  const { tag, role, classes, attributes } = site.target;
  if (tag && CONTROL_TAGS.includes(tag)) return "control";
  if (role && ITEM_ROLES.includes(role)) return "control";
  if (role && CONTAINER_ROLES.includes(role)) return "covered";
  if (attributes.includes(PASSIVE_SCROLL_REGION)) return "covered";
  if (site.target.inlineOutlineOff || classes.some((name) => OUTLINE_OFF_CLASS.test(name))) return "suppressed";
  if (suppressedByClass(site.target, rules)) return "suppressed";
  return undefined;
}

function placement(site: Site, rules: Rule[], explained: Explained): Placement | undefined {
  return placementOnMerits(site, rules) ?? (explained[site.file]?.kind === site.kind ? "explained" : undefined);
}

const where = (site: Site) => `${site.file}:${site.line}`;

function unplaced(sites: Site[], rules: Rule[], explained: Explained): string[] {
  return sites.filter((site) => placement(site, rules, explained) === undefined).map(where);
}

// An explanation that no longer matches a site it is needed for.
function staleExplanations(sites: Site[], rules: Rule[], explained: Explained): string[] {
  return Object.entries(explained)
    .filter(([file, { kind }]) => !sites.some((site) => site.file === file && site.kind === kind && placementOnMerits(site, rules) === undefined))
    .map(([file, { kind }]) => `${file} (${kind})`);
}

function containers(sites: Site[], rules: Rule[]): Site[] {
  return sites.filter((site) => ["covered", "suppressed"].includes(placementOnMerits(site, rules) ?? ""));
}

function ringed(sites: Site[], rules: Rule[]): string[] {
  return containers(sites, rules)
    .filter((site) => site.target.classes.some((name) => CONTAINER_RING_CLASS.test(name)))
    .map(where);
}

const roleContainers: Target[] = [
  ...CONTAINER_ROLES.map((role) => ({ role, classes: [], attributes: [], inlineOutlineOff: false })),
  { classes: [], attributes: [PASSIVE_SCROLL_REGION], inlineOutlineOff: false },
];

// The rule in the app's stylesheet that switches the outline off on every
// container while it has focus, outside any cascade layer so no layered rule
// can outrank it.
function coveringRule(rules: Rule[]): Rule | undefined {
  return rules.find(
    (rule) =>
      !rule.layered &&
      turnsOutlineOff(rule.style) &&
      roleContainers.every((target) => focusRuleOn(rule, target)),
  );
}

// Containers in a page that carries its own stylesheet, which its own sheet
// leaves with an outline on focus.
function uncoveredOwnPages(sites: Site[], ownStyles: Map<string, string>): string[] {
  return sites
    .filter((site) => ownStyles.has(site.file))
    .filter((site) => placementOnMerits(site, []) === "covered")
    .filter((site) => !cssRules(ownStyles.get(site.file)!).some((rule) => turnsOutlineOff(rule.style) && focusRuleOn(rule, site.target)))
    .map(where);
}

// Focus rules that draw on a container, reaching it by role, attribute or class.
function drawingOnContainers(sites: Site[], rules: Rule[]): string[] {
  const targets = [...roleContainers, ...containers(sites, rules).map((site) => site.target)];
  const drawing = rules.filter((rule) => draws(rule.style));
  const matches = targets.map((target) => focusRulesOn(drawing, target));
  return drawing
    .filter((_, index) => matches.some((target) => target[index]))
    .map((rule) => rule.selector);
}

// ---------------------------------------------------------------- the app

const scans = filesUnder(join(ROOT, SOURCE_DIR), (name) => /\.(tsx?|jsx?|html)$/.test(name) && !/\.(test|spec)\./.test(name)).map(
  (path) => scanFile(relative(ROOT, path), readFileSync(path, "utf8")),
);
const sites = scans.flatMap((scan) => scan.sites);
const ownStyles = new Map(scans.filter((scan) => scan.styles.length > 0).map((scan) => [scan.file, scan.styles.join("\n")]));

// Every stylesheet the app has, and every page that carries its own: a ring can
// come from any of them, and so can the rule that turns one off.
const everyRule = [
  ...filesUnder(join(ROOT, SOURCE_DIR), (name) => name.endsWith(".css")).map((path) => readFileSync(path, "utf8")),
  ...ownStyles.values(),
].flatMap(cssRules);

describe("focus rings belong to what the key acts on", () => {
  it("finds this app's focus sites at all", () => {
    // A scan that silently stopped finding sites would pass every check below.
    expect(sites.length).toBeGreaterThan(3);
    expect(ownStyles.size).toBeGreaterThan(0);
  });

  it("places every focus site as a control, a covered container, or an explained exception", () => {
    expect(unplaced(sites, everyRule, EXPLAINED)).toEqual([]);
  });

  it("explains only sites that still need it", () => {
    expect(staleExplanations(sites, everyRule, EXPLAINED)).toEqual([]);
  });

  it("gives no container a ring utility of its own", () => {
    expect(ringed(sites, everyRule)).toEqual([]);
  });

  it("covers the containers of a page that carries its own stylesheet, in that stylesheet", () => {
    expect(uncoveredOwnPages(sites, ownStyles)).toEqual([]);
  });

  it("turns the outline off for every container role in one unlayered rule", () => {
    const rules = cssRules(readFileSync(join(ROOT, COVERING_STYLESHEET), "utf8"));
    expect(coveringRule(rules), "the covering rule is missing").toBeDefined();
  });

  it("lets no other focus rule draw on a container, by role or by class", () => {
    expect(drawingOnContainers(sites, everyRule)).toEqual([]);
  });

  // Each check above, handed a source that breaks it, has to say so.
  it("rejects planted violations of every kind", () => {
    const planted = scanFile(
      "planted.tsx",
      [
        "export function Planted({ el }: { el: HTMLElement }) {",
        "  el.tabIndex = 0;",
        '  const props = { role: "presentation", tabIndex: 0 };',
        "  return (",
        "    <div {...props}>",
        '      <div className="planted-scroller" tabIndex={0} />',
        '      <div role="region" className="focus-visible:ring-2" tabIndex={0} />',
        '      <div role="listbox" className="planted-list" tabIndex={0} />',
        '      <button type="button" tabIndex={-1} />',
        "    </div>",
        "  );",
        "}",
      ].join("\n"),
    );
    const css = cssRules('.planted-list:focus-visible { outline: 2px solid red; } .planted-list:focus-visible .row { outline: 2px solid red; }');

    expect(planted.sites.map((site) => [site.line, site.kind])).toEqual([
      [2, "dom"],
      [3, "object"],
      [6, "attribute"],
      [7, "attribute"],
      [8, "attribute"],
      [9, "attribute"],
    ]);
    expect(unplaced(planted.sites, css, {})).toEqual(["planted.tsx:2", "planted.tsx:3", "planted.tsx:6"]);
    expect(ringed(planted.sites, css)).toEqual(["planted.tsx:7"]);
    expect(drawingOnContainers(planted.sites, css)).toEqual([".planted-list:focus-visible"]);

    // An explanation stands only while its site does.
    expect(staleExplanations(planted.sites, css, { "planted.tsx": { kind: "dom", reason: "planted" } })).toEqual([]);
    expect(staleExplanations(planted.sites, css, { "gone.tsx": { kind: "dom", reason: "planted" } })).toEqual(["gone.tsx (dom)"]);

    // A container is suppressed by its own class's focus rule, and only by that.
    const scroller = cssRules(".planted-scroller:focus { outline: none; }");
    expect(unplaced(planted.sites, scroller, {})).toEqual(["planted.tsx:2", "planted.tsx:3"]);

    // A page written as a string is read for its own stylesheet.
    const page = (css: string) =>
      scanFile("planted-page.ts", `export const page = \`<style>${css}</style><section role="region" tabindex="0">\${body}</section>\`;`);
    const bare = page("body { margin: 0 }");
    expect(uncoveredOwnPages(bare.sites, new Map([[bare.file, bare.styles.join("\n")]]))).toEqual(["planted-page.ts:1"]);
    const covered = page('[role="region"]:focus-visible { outline: none }');
    expect(uncoveredOwnPages(covered.sites, new Map([[covered.file, covered.styles.join("\n")]]))).toEqual([]);

    // A covering rule that leaves out a role, or sits in a layer, does not cover.
    const every = `:is(${CONTAINER_ROLES.map((role) => `[role="${role}"]`).join(", ")}, [${PASSIVE_SCROLL_REGION}]):focus-visible { outline: none; }`;
    expect(coveringRule(cssRules(every))).toBeDefined();
    expect(coveringRule(cssRules(':is([role="listbox"], [role="region"]):focus-visible { outline: none; }'))).toBeUndefined();
    expect(coveringRule(cssRules(`@layer base { ${every} }`))).toBeUndefined();
  });
});
