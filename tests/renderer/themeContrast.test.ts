import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Every color pair the stylesheet draws must meet WCAG AA in both themes
// (app-chrome conventions, Theme): 4.5:1 for text, 3:1 for the boundaries that
// alone identify a control. The light tokens live in the top-level :root block;
// the dark tokens in the :root block inside @media (prefers-color-scheme: dark).
const css = readFileSync(`${process.cwd()}/src/renderer/src/App.css`, "utf8");

type Rgb = [number, number, number];

function themeBlock(theme: "light" | "dark"): string {
  if (theme === "light") {
    const start = css.search(/^:root\s*\{/m);
    return css.slice(css.indexOf("{", start), css.indexOf("\n}", start));
  }
  const media = css.indexOf("@media (prefers-color-scheme: dark) {");
  expect(media, "the dark theme must be a prefers-color-scheme block").toBeGreaterThanOrEqual(0);
  const start = css.indexOf("  :root {", media);
  return css.slice(css.indexOf("{", start), css.indexOf("\n  }", start));
}

function hexOf(block: string, token: string): Rgb {
  const value = block.match(new RegExp(`${token.replaceAll("-", "\\-")}\\s*:\\s*(#[0-9a-f]{6})\\s*;`, "i"))?.[1];
  expect(value, `${token} must be an opaque six-digit hex color`).toBeTruthy();
  return [1, 3, 5].map((offset) => Number.parseInt(value!.slice(offset, offset + 2), 16)) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(first: Rgb, second: Rgb): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const SURFACES = ["--bm-bg", "--bm-surface", "--bm-surface-muted", "--bm-surface-raised", "--bm-panel"];
const SYNTAX = [
  "meta", "keyword", "atom", "literal", "string", "regexp", "definition",
  "local", "type", "class", "special", "property", "comment", "invalid",
].map((name) => `--bm-syntax-${name}`);

const TEXT_PAIRS: ReadonlyArray<[string, string]> = [
  ...["--bm-text", "--bm-text-soft", "--bm-text-muted", "--bm-text-faint", "--bm-accent-fg"].flatMap(
    (ink): Array<[string, string]> => SURFACES.map((surface) => [ink, surface]),
  ),
  ["--bm-on-accent", "--bm-accent"],
  ["--bm-on-accent", "--bm-accent-hover"],
  ["--bm-text", "--bm-accent-soft"],
  ["--bm-text", "--bm-accent-subtle"],
  ["--bm-warning", "--bm-surface"],
  ["--bm-warning", "--bm-panel"],
  ["--bm-warning", "--bm-warning-soft"],
  ["--bm-danger", "--bm-surface"],
  ["--bm-danger", "--bm-panel"],
  ["--bm-danger", "--bm-danger-soft"],
  // The editor draws on --bm-surface.
  ...SYNTAX.map((token): [string, string] => [token, "--bm-surface"]),
];

const BOUNDARY_PAIRS: ReadonlyArray<[string, string]> = [
  ...SURFACES.map((surface): [string, string] => ["--bm-input-border", surface]),
];

describe("theme token contrast", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`keeps text at 4.5:1 or more in the ${theme} theme`, () => {
      const block = themeBlock(theme);
      for (const [foreground, background] of TEXT_PAIRS) {
        expect(contrast(hexOf(block, foreground), hexOf(block, background)), `${foreground} on ${background}`)
          .toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`keeps form-field outlines at 3:1 or more in the ${theme} theme`, () => {
      const block = themeBlock(theme);
      for (const [foreground, background] of BOUNDARY_PAIRS) {
        expect(contrast(hexOf(block, foreground), hexOf(block, background)), `${foreground} on ${background}`)
          .toBeGreaterThanOrEqual(3);
      }
    });
  }
});
