import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: {} }));

import { renderPlainMessageDialogHtml } from "@main/plain-message-dialog";

describe("plain message dialog", () => {
  it("keeps header and footer fixed while only the body scrolls", () => {
    const html = renderPlainMessageDialogHtml({ title: "Title", message: "Message", detail: "Detail" }, ["OK"]);

    expect(html).toContain('id="dialog-header"');
    expect(html).toContain('id="dialog-body"');
    expect(html).toContain('id="dialog-footer"');
    expect(html).toContain(".body{min-height:0;overflow:auto");
    expect(html).toContain("body{margin:0;height:100vh;overflow:hidden}");
  });

  it("preserves neutral, primary, and destructive intent on hover and focus", () => {
    const html = renderPlainMessageDialogHtml(
      { title: "Choice", message: "Choose", defaultId: 1, destructiveId: 2 },
      ["Cancel", "Continue", "Quit"],
    );

    expect(html).toContain('class="button"');
    expect(html).toContain('class="button primary"');
    expect(html).toContain('class="button destructive"');
    expect(html).toContain(".primary:hover,.primary:focus{background:#1d4ed8}");
    expect(html).toContain(".destructive:hover,.destructive:focus{background:#991b1b}");
    expect(html).not.toMatch(/\.button:hover,\.button:focus\{background:/);
  });
});
