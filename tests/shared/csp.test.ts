import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { CONTENT_SECURITY_POLICY, cspMetaTag, withCspMeta } from "@shared/csp.js";

// The policy as a browser reads it: directive name to its source list.
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(";")
      .map((directive) => directive.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name!.toLowerCase(), sources]),
  );
}

describe("the renderer's Content-Security-Policy", () => {
  // The packaged app loads the renderer over file://, where a CSP delivered as an
  // HTTP response header does not apply, so a header-only policy would leave the
  // shipped build with none at all while the code read as though it had one.
  it("is inserted as the first thing inside <head>", () => {
    const html = "<!DOCTYPE html>\n<html>\n  <head>\n    <title>x</title>\n  </head>\n</html>";

    const out = withCspMeta(html);

    const { head } = new JSDOM(out).window.document;
    const first = head.firstElementChild;
    expect(first?.tagName).toBe("META");
    expect(first?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(first?.getAttribute("content")).toBe(CONTENT_SECURITY_POLICY);
    expect(first?.outerHTML).toBe(new JSDOM(cspMetaTag()).window.document.head.innerHTML);
    expect(head.querySelector("title")?.textContent).toBe("x");
  });

  it("refuses HTML it cannot place the policy in, rather than passing it through", () => {
    // Returning the input unchanged here would ship a build with no policy — the
    // exact failure this module exists to end — and nothing downstream would notice.
    expect(() => withCspMeta("<html><body>no head</body></html>")).toThrow(/no <head>/);
  });

  it("keeps a local-first app local and shuts the classic script vectors", () => {
    // img-src is the directive that stops a post pasted from the web, or a model's
    // analysis output, silently fetching from whatever host the markdown names.
    const policy = directives(CONTENT_SECURITY_POLICY);
    expect(policy.get("img-src")).toEqual(["'self'", "data:", "bigmouth-asset:"]);
    expect(policy.get("script-src")).toEqual(["'self'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'self'"]);
  });

  it("omits frame-ancestors, which a meta-delivered policy ignores", () => {
    // Listing it would log a console warning and protect nothing.
    expect(directives(CONTENT_SECURITY_POLICY).has("frame-ancestors")).toBe(false);
  });

  // Every page the renderer build serves gets the injected policy, so none of
  // them may carry a second one that would narrow or contradict it.
  it("is the only policy in play — the source HTML declares none of its own", () => {
    const pages = fs.readdirSync("src/renderer").filter((name) => name.endsWith(".html"));
    expect(pages).toContain("index.html");
    for (const name of pages) {
      const { document } = new JSDOM(fs.readFileSync(`src/renderer/${name}`, "utf8")).window;
      const declared = [...document.querySelectorAll("meta[http-equiv]")].filter(
        (meta) => meta.getAttribute("http-equiv")?.toLowerCase() === "content-security-policy",
      );
      expect(declared, name).toEqual([]);
    }
  });
});
