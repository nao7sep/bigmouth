import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";

import { ExportModal } from "@renderer/components/ExportModal";

const MARKDOWN = "# Heading\n\nsome **bold** text and a [link](https://x.test)";

// jsdom has no real clipboard or object-URL plumbing; stub both so Copy and
// Download exercise their code paths without touching the platform.
const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  // jsdom's object-URL plumbing is a no-op; install spies we can assert on.
  URL.createObjectURL = vi.fn(() => "blob:export");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  writeText.mockClear();
});

function renderExport(content = MARKDOWN, slug = "my-post") {
  return render(<ExportModal content={content} slug={slug} onClose={vi.fn()} />);
}

describe("ExportModal — render and format selection", () => {
  it("renders the dialog and defaults to HTML, showing the rendered markup", () => {
    const { getByRole, container } = renderExport();
    const labelId = getByRole("dialog").getAttribute("aria-labelledby");
    expect(document.getElementById(labelId!)?.textContent).toBe("Export");

    // The HTML radio is checked by default and the preview holds the rendered HTML.
    const htmlRadio = getByRole("radio", { name: "HTML" }) as HTMLInputElement;
    expect(htmlRadio.checked).toBe(true);
    const preview = container.querySelector(".export-preview")!;
    expect(preview.textContent).toContain("<h1>Heading</h1>");
    expect(preview.textContent).toContain("<strong>bold</strong>");
  });

  it("switches to plain text, stripping markdown and updating the download label", () => {
    const { getByRole, container, getByText } = renderExport();
    fireEvent.click(getByRole("radio", { name: "Plain Text" }));

    const preview = container.querySelector(".export-preview")!;
    // remove-markdown drops the emphasis/heading syntax.
    expect(preview.textContent).toContain("Heading");
    expect(preview.textContent).toContain("some bold text");
    expect(preview.textContent).not.toContain("**");
    expect(preview.textContent).not.toContain("<h1>");
    // The download button reflects the .txt extension.
    expect(getByText("Download .txt")).toBeTruthy();
  });

  it("shows the placeholder when there is no content", () => {
    const { getByText } = renderExport("", "x");
    expect(getByText("No content yet")).toBeTruthy();
  });
});

describe("ExportModal — copy", () => {
  it("writes the current output to the clipboard and flashes confirmation", () => {
    const { getByText } = renderExport();
    fireEvent.click(getByText("Copy"));

    // The HTML output was copied.
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("<h1>Heading</h1>");
    // The button flips to the copied state...
    expect(getByText("✓ Copied")).toBeTruthy();
    // ...and reverts after the feedback window elapses.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(getByText("Copy")).toBeTruthy();
  });
});

describe("ExportModal — download", () => {
  it("downloads an .html blob using the slug as the filename", () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { getByText } = renderExport(MARKDOWN, "my-post");

    fireEvent.click(getByText("Download .html"));

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    const blob = (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/html");
    expect(click).toHaveBeenCalledTimes(1);
    // The temporary object URL is released after the click.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:export");
    click.mockRestore();
  });

  it("falls back to 'export' as the filename when the slug is blank, and writes a text blob in plain-text mode", () => {
    const captured: { download?: string } = {};
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        captured.download = this.download;
      });
    const { getByText, getByRole } = renderExport(MARKDOWN, "");

    fireEvent.click(getByRole("radio", { name: "Plain Text" }));
    fireEvent.click(getByText("Download .txt"));

    expect(captured.download).toBe("export.txt");
    const blob = (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/plain");
    click.mockRestore();
  });
});

describe("ExportModal — close", () => {
  it("closes on Escape (no dirty-state guard)", () => {
    const onClose = vi.fn();
    render(<ExportModal content={MARKDOWN} slug="x" onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
