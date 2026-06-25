import { afterEach, describe, it, expect, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { createRef } from "react";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@renderer/components/MarkdownEditor";

afterEach(cleanup);

// CodeMirror's view layer needs a few layout/measurement APIs jsdom does not
// implement. We don't drive real editing through the DOM; instead we reach the
// imperative handle and read the document back from CodeMirror's own model. The
// returned container holds the mounted .cm-container.
function renderEditor(
  props: Partial<React.ComponentProps<typeof MarkdownEditor>> = {}
) {
  const onContentChange = props.onContentChange ?? vi.fn();
  const ref = createRef<MarkdownEditorHandle>();
  const utils = render(
    <MarkdownEditor
      ref={ref}
      content={props.content ?? ""}
      onContentChange={onContentChange}
      watermark={props.watermark ?? "Write here…"}
      readOnly={props.readOnly}
    />
  );
  return { ...utils, ref, onContentChange };
}

describe("MarkdownEditor mounting", () => {
  it("mounts a CodeMirror editor into a .cm-container", () => {
    const { container } = renderEditor({ content: "hello world" });
    expect(container.querySelector(".cm-container")).toBeTruthy();
    // CodeMirror renders an editor element inside the container.
    expect(container.querySelector(".cm-editor")).toBeTruthy();
  });

  it("seeds the editor document from the initial content prop", () => {
    const { container } = renderEditor({ content: "seed text" });
    expect(container.querySelector(".cm-content")?.textContent).toContain("seed text");
  });

  it("renders the watermark as the placeholder when empty", () => {
    const { container } = renderEditor({ content: "", watermark: "Start typing" });
    // CodeMirror renders the placeholder text into the content area when empty.
    expect(container.textContent).toContain("Start typing");
  });
});

describe("MarkdownEditor external content sync", () => {
  it("pushes a changed content prop into the editor document", () => {
    const { container, rerender, ref, onContentChange } = renderEditor({
      content: "first",
    });
    rerender(
      <MarkdownEditor
        ref={ref}
        content="second"
        onContentChange={onContentChange}
        watermark="w"
      />
    );
    expect(container.querySelector(".cm-content")?.textContent).toContain("second");
  });

  it("suppresses the change callback while syncing an external content change", () => {
    // The external-sync effect sets a suppress flag so the programmatic dispatch
    // does not echo back through onContentChange as if the user typed.
    const onContentChange = vi.fn();
    const { rerender, ref } = renderEditor({ content: "first", onContentChange });
    rerender(
      <MarkdownEditor
        ref={ref}
        content="externally changed"
        onContentChange={onContentChange}
        watermark="w"
      />
    );
    expect(onContentChange).not.toHaveBeenCalled();
  });

  it("does not re-dispatch when the content prop matches the current document", () => {
    const onContentChange = vi.fn();
    const { rerender, ref } = renderEditor({ content: "same", onContentChange });
    // Re-render with an unrelated prop change but identical content.
    rerender(
      <MarkdownEditor
        ref={ref}
        content="same"
        onContentChange={onContentChange}
        watermark="different watermark"
      />
    );
    expect(onContentChange).not.toHaveBeenCalled();
  });
});

describe("MarkdownEditor insertAtCursor handle", () => {
  it("inserts text at the cursor and reports the change", () => {
    const onContentChange = vi.fn();
    const { ref, container } = renderEditor({ content: "AB", onContentChange });
    act(() => {
      ref.current!.insertAtCursor("X");
    });
    // Default cursor is at the document start (from === to === 0), so "X" lands
    // before "AB".
    expect(container.querySelector(".cm-content")?.textContent).toContain("XAB");
    // A real user edit (not suppressed) fires the change callback with the new doc.
    expect(onContentChange).toHaveBeenCalledWith("XAB");
  });

  it("does not insert when the editor is read-only", () => {
    const onContentChange = vi.fn();
    const { ref, container } = renderEditor({
      content: "locked",
      readOnly: true,
      onContentChange,
    });
    act(() => {
      ref.current!.insertAtCursor("nope");
    });
    expect(container.querySelector(".cm-content")?.textContent).toContain("locked");
    expect(container.querySelector(".cm-content")?.textContent).not.toContain("nope");
    expect(onContentChange).not.toHaveBeenCalled();
  });
});

describe("MarkdownEditor read-only reconfiguration", () => {
  it("becomes editable after readOnly flips from true to false", () => {
    const onContentChange = vi.fn();
    const { ref, rerender, container } = renderEditor({
      content: "doc",
      readOnly: true,
      onContentChange,
    });
    // While locked, the insert is a no-op.
    act(() => ref.current!.insertAtCursor("a"));
    expect(onContentChange).not.toHaveBeenCalled();

    rerender(
      <MarkdownEditor
        ref={ref}
        content="doc"
        onContentChange={onContentChange}
        watermark="w"
        readOnly={false}
      />
    );
    act(() => ref.current!.insertAtCursor("Z"));
    expect(container.querySelector(".cm-content")?.textContent).toContain("Zdoc");
    expect(onContentChange).toHaveBeenCalledWith("Zdoc");
  });
});
