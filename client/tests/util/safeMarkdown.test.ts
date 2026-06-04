import { describe, it, expect } from "vitest";
import { renderSafeMarkdown } from "../../src/../src/util/safeMarkdown";

describe("renderSafeMarkdown", () => {
  it("renders ordinary markdown", () => {
    const html = renderSafeMarkdown("# Title\n\nSome **bold** text.");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("renders links", () => {
    const html = renderSafeMarkdown("[home](https://example.com)");
    expect(html).toContain('href="https://example.com"');
  });

  it("strips <script> tags", () => {
    const html = renderSafeMarkdown("<script>alert(1)</script>ok");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
  });

  it("strips inline event handlers like onerror", () => {
    const html = renderSafeMarkdown('<img src="x" onerror="alert(1)">');
    expect(html.toLowerCase()).not.toContain("onerror");
  });

  it("removes <iframe> and its srcdoc", () => {
    const html = renderSafeMarkdown(
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>'
    );
    expect(html.toLowerCase()).not.toContain("<iframe");
    expect(html.toLowerCase()).not.toContain("srcdoc");
  });

  it("strips inline style attributes", () => {
    const html = renderSafeMarkdown('<p style="position:fixed">x</p>');
    expect(html.toLowerCase()).not.toContain("style=");
  });

  it("drops disallowed form/input elements", () => {
    const html = renderSafeMarkdown(
      "<form><input name='a'><button>go</button></form>"
    );
    const lower = html.toLowerCase();
    expect(lower).not.toContain("<form");
    expect(lower).not.toContain("<input");
    expect(lower).not.toContain("<button");
  });
});
