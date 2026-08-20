import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { CONTENT_SECURITY_POLICY, cspMetaTag, withCspMeta } from "@shared/csp.js";

describe("the renderer's Content-Security-Policy", () => {
  // The packaged app loads the renderer over file://, where a CSP delivered as an
  // HTTP response header does not apply — which is what the app used to do, so the
  // shipped build ran with no policy at all while the code read as though it had one.
  it("is inserted as the first thing inside <head>", () => {
    const html = "<!DOCTYPE html>\n<html>\n  <head>\n    <title>x</title>\n  </head>\n</html>";

    const out = withCspMeta(html);

    expect(out).toContain(cspMetaTag());
    expect(out.indexOf(cspMetaTag())).toBeLessThan(out.indexOf("<title>"));
  });

  it("refuses HTML it cannot place the policy in, rather than passing it through", () => {
    // Returning the input unchanged here would ship a build with no policy — the
    // exact failure this module exists to end — and nothing downstream would notice.
    expect(() => withCspMeta("<html><body>no head</body></html>")).toThrow(/no <head>/);
  });

  it("keeps a local-first app local and shuts the classic script vectors", () => {
    // img-src is the directive that stops a post pasted from the web, or a model's
    // analysis output, silently fetching from whatever host the markdown names.
    expect(CONTENT_SECURITY_POLICY).toContain("img-src 'self' data: bigmouth-asset:");
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("base-uri 'self'");
  });

  it("omits frame-ancestors, which a meta-delivered policy ignores", () => {
    // Listing it would log a console warning and protect nothing.
    expect(CONTENT_SECURITY_POLICY).not.toContain("frame-ancestors");
  });

  it("is the only policy in play — the source HTML declares none of its own", () => {
    const html = fs.readFileSync("src/renderer/index.html", "utf8");
    expect(html).not.toContain("http-equiv");
  });
});
