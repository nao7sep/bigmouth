import { describe, it, expect } from "vitest";
import { themeTokens } from "../appStylesheet";

// Every color pair the stylesheet draws keeps high contrast in both themes,
// by this app's own floor: 4.5:1 for text, 3:1 for the boundaries that
// alone identify a control.

type Rgb = [number, number, number];

function hexOf(tokens: ReadonlyMap<string, string>, token: string): Rgb {
  const value = tokens.get(token);
  expect(value, `${token} must be an opaque six-digit hex color`).toMatch(/^#[0-9a-f]{6}$/i);
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
// Every syntax token the light theme declares; the dark theme must declare the same set.
const syntaxIn = (tokens: ReadonlyMap<string, string>) =>
  [...tokens.keys()].filter((token) => token.startsWith("--bm-syntax-")).sort();
const SYNTAX = syntaxIn(themeTokens.light);

const TEXT_PAIRS: ReadonlyArray<[string, string]> = [
  ...["--bm-text", "--bm-text-soft", "--bm-text-muted", "--bm-text-faint", "--bm-accent-fg"].flatMap(
    (ink): Array<[string, string]> => SURFACES.map((surface) => [ink, surface]),
  ),
  ["--bm-on-accent", "--bm-accent"],
  // A destructive CONFIRM button is filled, so its ink is read on the fill.
  ["--bm-on-danger", "--bm-danger-fill"],
  ["--bm-on-danger", "--bm-danger-fill-hover"],
  ["--bm-on-accent", "--bm-accent-hover"],
  ["--bm-text", "--bm-accent-soft"],
  ["--bm-text", "--bm-accent-subtle"],
  // Tabs retain their resting/open-panel ink on hover and keyboard fills.
  ["--bm-text-muted", "--bm-control-hover"],
  ["--bm-accent-fg", "--bm-control-hover"],
  ["--bm-accent-fg", "--bm-control-pressed"],
  ["--bm-warning", "--bm-surface"],
  ["--bm-warning", "--bm-panel"],
  ["--bm-warning", "--bm-warning-soft"],
  ["--bm-danger", "--bm-surface"],
  ["--bm-danger", "--bm-panel"],
  ["--bm-danger", "--bm-danger-soft"],
  // Buttons and segmented controls: labels on every resting, hover, and
  // pressed surface they take. A danger button hovers on --bm-danger-soft.
  ...["--bm-control-bg", "--bm-control-hover", "--bm-control-pressed"].flatMap(
    (surface): Array<[string, string]> => [
      ["--bm-text", surface],
      ["--bm-text-soft", surface],
    ],
  ),
  ["--bm-danger", "--bm-control-bg"],
  ["--bm-danger", "--bm-danger-soft-pressed"],
  // The destructive CONFIRM button is filled, so its ink is read on the fill in
  // every state it takes, the press included.
  ["--bm-on-danger", "--bm-danger-fill-pressed"],
  ["--bm-text-soft", "--bm-track"],
  ["--bm-on-accent", "--bm-accent-pressed"],
  // The editor draws on --bm-surface.
  ...SYNTAX.map((token): [string, string] => [token, "--bm-surface"]),
];

const BOUNDARY_PAIRS: ReadonlyArray<[string, string]> = [
  ...SURFACES.map((surface): [string, string] => ["--bm-input-border", surface]),
  // The keyboard ring on a selected segment is drawn in the fill's own ink.
  ["--bm-on-accent", "--bm-accent"],
];

describe("theme token contrast", () => {
  it("gives both themes the same syntax tokens", () => {
    expect(SYNTAX.length).toBeGreaterThan(0);
    expect(syntaxIn(themeTokens.dark)).toEqual(SYNTAX);
  });

  for (const theme of ["light", "dark"] as const) {
    it(`keeps text at 4.5:1 or more in the ${theme} theme`, () => {
      const tokens = themeTokens[theme];
      for (const [foreground, background] of TEXT_PAIRS) {
        expect(contrast(hexOf(tokens, foreground), hexOf(tokens, background)), `${foreground} on ${background}`)
          .toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`keeps form-field outlines and focus rings at 3:1 or more in the ${theme} theme`, () => {
      const tokens = themeTokens[theme];
      for (const [foreground, background] of BOUNDARY_PAIRS) {
        expect(contrast(hexOf(tokens, foreground), hexOf(tokens, background)), `${foreground} on ${background}`)
          .toBeGreaterThanOrEqual(3);
      }
    });
  }
});
