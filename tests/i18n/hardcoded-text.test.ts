import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

// Interface text comes from the catalogues. This scan of the renderer fails on
// words written straight into JSX: text between tags, a string in braces, or a string given
// to an attribute a person reads or hears. Names and literal values that are
// the same in every language are listed.

const SOURCE = join(process.cwd(), "src/renderer/src");

const READ_ATTRIBUTES = new Set([
  "title",
  "aria-label",
  "aria-description",
  "placeholder",
  "alt",
  "label",
  "passiveContentLabel",
]);

const LITERAL_TEXT = new Set([
  "BigMouth",
  "GitHub",
  // The workspace's posts folder, shown as a path.
  "posts",
  // Example language codes, the values the field takes.
  "en, ja, es, fr, de",
]);

type Node = { type: string; loc?: { start: { line: number } }; [key: string]: unknown };

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

// Whether text is words a person reads. A listed literal is not, and is noted in
// `allowed` so a listed entry nothing uses any more is caught.
function hasWords(text: string, allowed: Set<string>): boolean {
  if (!/\p{L}/u.test(text)) return false;
  if (!LITERAL_TEXT.has(text.trim())) return true;
  allowed.add(text.trim());
  return false;
}

function literalText(node: Node | undefined): string | null {
  if (!node) return null;
  if (node.type === "StringLiteral") return node.value as string;
  if (node.type === "TemplateLiteral") {
    return (node.quasis as Array<{ value: { cooked: string } }>).map((quasi) => quasi.value.cooked).join(" ");
  }
  return null;
}

type Scan = { found: string[]; allowed: Set<string> };

function findings(file: string): Scan {
  return findingsIn(relative(process.cwd(), file), readFileSync(file, "utf8"));
}

function findingsIn(name: string, source: string): Scan {
  const ast = parse(source, { sourceType: "module", plugins: ["jsx", "typescript"] });
  const found: string[] = [];
  const allowed = new Set<string>();
  const report = (node: Node, text: string) => found.push(`${name}:${node.loc?.start.line}: ${JSON.stringify(text.trim())}`);

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== "object" || typeof (node as Node).type !== "string") return;
    const current = node as Node;

    if (current.type === "JSXText" && hasWords(current.value as string, allowed)) {
      report(current, current.value as string);
    }
    if (current.type === "JSXExpressionContainer" && current.expression) {
      const text = literalText(current.expression as Node);
      // An attribute's braces are judged with the attribute below.
      if (text !== null && !(current as { inAttribute?: boolean }).inAttribute && hasWords(text, allowed)) {
        report(current, text);
      }
    }
    if (current.type === "JSXAttribute") {
      const name = (current.name as { name: string }).name;
      const value = current.value as Node | null;
      if (value?.type === "JSXExpressionContainer") {
        (value as { inAttribute?: boolean }).inAttribute = true;
      }
      const text = value?.type === "JSXExpressionContainer" ? literalText(value.expression as Node) : literalText(value ?? undefined);
      if (READ_ATTRIBUTES.has(name) && text !== null && hasWords(text, allowed)) {
        report(current, text);
      }
    }

    for (const [key, child] of Object.entries(current)) {
      if (key !== "loc" && key !== "start" && key !== "end") visit(child);
    }
  };

  visit(ast.program);
  return { found, allowed };
}

const scans = tsxFiles(SOURCE).map(findings);

describe("interface text", () => {
  it("comes from the catalogues, not from JSX literals", () => {
    expect(scans.flatMap((scan) => scan.found)).toEqual([]);
  });

  it("lists only literals the interface still shows", () => {
    const used = new Set(scans.flatMap((scan) => [...scan.allowed]));
    expect([...LITERAL_TEXT].filter((entry) => !used.has(entry))).toEqual([]);
  });

  // A scan that stopped seeing JSX would pass the check above on any source.
  it("rejects words written into JSX in each place it looks", () => {
    const planted = [
      "export function Planted({ count }: { count: number }) {",
      "  return (",
      '    <section className="planted words" aria-label="Planted region">',
      "      Planted heading",
      '      <img alt={"A planted photo"} src="x.png" />',
      "      {`Planted ${count} words`}",
      "      <span>BigMouth</span>",
      "    </section>",
      "  );",
      "}",
    ].join("\n");
    expect(findingsIn("planted.tsx", planted)).toEqual({
      found: [
        'planted.tsx:3: "Planted region"',
        'planted.tsx:3: "Planted heading"',
        'planted.tsx:5: "A planted photo"',
        'planted.tsx:6: "Planted   words"',
      ],
      allowed: new Set(["BigMouth"]),
    });
  });
});
