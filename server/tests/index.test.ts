import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard for the PRODUCTION Content-Security-Policy.
//
// The launcher conventions require the production server to emit a non-null,
// strict CSP on the served SPA document. That policy is built inline in
// src/index.ts as a local `const CONTENT_SECURITY_POLICY` (it is not exported,
// and importing index.ts boots the listening server), so this guard reads it
// straight out of the source instead. The point is to catch a future edit that
// silently drops or weakens the policy — a strict CSP that quietly turns into
// `script-src 'self' 'unsafe-inline'`, or vanishes entirely, must fail here.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexSource = fs.readFileSync(
  path.resolve(__dirname, "../src/index.ts"),
  "utf-8",
);

// Extract the directive list from the `const CONTENT_SECURITY_POLICY = [...]`
// array literal and rebuild it exactly as production does (`.join("; ")`), so
// the assertions below run against the real shipped policy string.
function readProductionCsp(): string {
  const match = indexSource.match(
    /const CONTENT_SECURITY_POLICY = \[([\s\S]*?)\]\.join\("; "\)/,
  );
  if (!match) {
    throw new Error(
      "Could not locate the CONTENT_SECURITY_POLICY array in src/index.ts; " +
        "if the policy moved or changed shape, update this guard.",
    );
  }
  const directives = [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(
    (m) => m[1],
  );
  return directives.join("; ");
}

describe("production Content-Security-Policy", () => {
  const csp = readProductionCsp();

  it("is present and non-empty", () => {
    expect(csp.length).toBeGreaterThan(0);
  });

  it("has a strict script-src (no 'unsafe-inline', no 'unsafe-eval')", () => {
    const scriptSrc = csp
      .split("; ")
      .find((d) => d.startsWith("script-src "));
    expect(scriptSrc).toBe("script-src 'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    // 'unsafe-eval' must appear in no directive at all.
    expect(csp).not.toContain("'unsafe-eval'");
    // The only 'unsafe-inline' the policy is allowed to carry is the
    // documented style-src exception (CodeMirror's runtime <style> themes).
    // Anywhere else is a regression.
    const inlineDirectives = csp
      .split("; ")
      .filter((d) => d.includes("'unsafe-inline'"));
    expect(inlineDirectives).toEqual(["style-src 'self' 'unsafe-inline'"]);
  });

  it("matches the exact pinned production policy", () => {
    // Snapshot of the CURRENT shipped CSP. Any dropped or weakened directive
    // changes this string and fails the test; tightening it is an intentional
    // edit that updates this expectation alongside src/index.ts.
    expect(csp).toBe(
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "media-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
  });
});
