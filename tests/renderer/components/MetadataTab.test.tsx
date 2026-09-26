import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { createRef } from "react";

// MetadataTab only talks to the main process through these api calls.
vi.mock("@renderer/api", () => ({
  reportProblem: vi.fn(),
  queuePostMetadata: vi.fn(),
  reportMetadataRefusal: vi.fn(),
  generateMetadataField: vi.fn(),
  generateMetadataFields: vi.fn(),
}));

import { MetadataTab, type MetadataTabHandle } from "@renderer/components/MetadataTab";
import {
  queuePostMetadata,
  reportMetadataRefusal,
  generateMetadataField,
  generateMetadataFields,
} from "@renderer/api";
import type { PostFrontMatter } from "@shared/types";

const mockQueue = vi.mocked(queuePostMetadata);
const mockReportRefusal = vi.mocked(reportMetadataRefusal);
const mockGenerateMetadataField = vi.mocked(generateMetadataField);
const mockGenerateMetadataFields = vi.mocked(generateMetadataFields);

function frontMatter(): PostFrontMatter {
  return {
    id: "p1",
    target: "blog",
    status: "draft",
    language: "en",
    createdAtUtc: "2024-01-01T00:00:00.000Z",
    title: "",
  };
}

/** Every edit the tab sent to the store's buffer, in order. */
function queuedEdits(): Record<string, unknown>[] {
  return mockQueue.mock.calls.map(([, edits]) => edits as Record<string, unknown>);
}

function renderTab(
  overrides: Partial<{
    frontMatter: PostFrontMatter;
    content: string;
    readOnly: boolean;
    extraFieldWatermark: string;
  }> = {}
) {
  const ref = createRef<MetadataTabHandle>();
  const onMetadataEdited = vi.fn();
  const { container } = render(
    <MetadataTab
      ref={ref}
      workspaceId="w1"
      postId="p1"
      frontMatter={overrides.frontMatter ?? frontMatter()}
      content={overrides.content ?? "some body text"}
      extraFieldWatermark={overrides.extraFieldWatermark ?? ""}
      onMetadataEdited={onMetadataEdited}
      readOnly={overrides.readOnly}
    />
  );
  // The Title field is the first textarea rendered.
  const titleInput = container.querySelectorAll("textarea")[0] as HTMLTextAreaElement;
  return { ref, container, titleInput, onMetadataEdited };
}

function renderTabWithUnmount() {
  const utils = render(
    <MetadataTab
      workspaceId="w1"
      postId="p1"
      frontMatter={frontMatter()}
      content="some body text"
      extraFieldWatermark=""
      onMetadataEdited={vi.fn()}
    />
  );
  return { container: utils.container, unmount: utils.unmount };
}

// Field order (en): Title, Slug, Tags, Description, Extra.
function slugInput(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelectorAll("textarea")[1] as HTMLTextAreaElement;
}

// The Copy buttons go through useCopyFeedback → navigator.clipboard.
let clipboardWrite: ReturnType<typeof vi.fn>;
let originalClipboard: PropertyDescriptor | undefined;

beforeEach(() => {
  mockQueue.mockReset();
  mockQueue.mockResolvedValue(null);
  mockReportRefusal.mockReset();
  mockGenerateMetadataField.mockReset();
  mockGenerateMetadataFields.mockReset();
  clipboardWrite = vi.fn().mockResolvedValue(undefined);
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
});

afterEach(() => {
  cleanup();
  if (originalClipboard) {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  } else {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
});

describe("MetadataTab edits stream to the store", () => {
  // The main process owns the write and the flush at quit, so an edit must
  // leave the renderer at once — nothing may wait on a renderer timer that a
  // quit or a closed window would discard.
  it("sends each edit to the store's buffer as it is typed", async () => {
    const { titleInput, onMetadataEdited } = renderTab();

    await act(async () => {
      fireEvent.change(titleInput, { target: { value: "Hello" } });
    });

    expect(mockQueue).toHaveBeenCalledWith("p1", { title: "Hello" }, "w1");
    expect(onMetadataEdited).toHaveBeenCalledWith("p1", { title: "Hello" });
  });

  it("normalizes tags into an array for the store, keeping what was typed on screen", async () => {
    const { container } = renderTab();
    const tagsInput = container.querySelectorAll("textarea")[2] as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(tagsInput, { target: { value: "a, b ,, c" } });
    });
    expect(mockQueue).toHaveBeenCalledWith("p1", { tags: ["a", "b", "c"] }, "w1");
    expect(tagsInput.value).toBe("a, b ,, c");
  });

  it("autosaves an edit to the Title (English) companion field", async () => {
    const { container } = renderTab({ frontMatter: { ...frontMatter(), language: "ja" } });
    const titleEn = container.querySelectorAll("textarea")[1] as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(titleEn, { target: { value: "New En" } });
    });
    expect(mockQueue).toHaveBeenCalledWith("p1", { titleEn: "New En" }, "w1");
  });

  it("reports a refused slug on blur, and will not let the post be left while it stands", async () => {
    mockQueue.mockImplementation(async (_id, edits) =>
      (edits as { slug?: string }).slug === "taken" ? 'Another post already uses the slug "taken"' : null
    );
    const { container, ref } = renderTab();
    const slug = slugInput(container);

    await act(async () => {
      fireEvent.change(slug, { target: { value: "taken" } });
    });
    // Not while typing: a slug passes through values other posts use.
    expect(container.querySelector(".metadata-error")).toBeNull();
    await act(async () => {
      fireEvent.blur(slug);
    });
    expect(container.querySelector(".metadata-error")?.textContent).toContain("already uses the slug");

    let flushed: boolean | undefined;
    await act(async () => {
      flushed = await ref.current!.flushPendingChanges();
    });
    expect(flushed).toBe(false);

    // Fixing the field clears the refusal and lets the post go.
    await act(async () => {
      fireEvent.change(slug, { target: { value: "free" } });
    });
    expect(container.querySelector(".metadata-error")).toBeNull();
    await act(async () => {
      flushed = await ref.current!.flushPendingChanges();
    });
    expect(flushed).toBe(true);
  });

  // A refused value was never buffered, so quitting or closing the window must
  // ask before it goes. Main can only ask if the tab says so, without a blur.
  it("tells main while a field shows a refused value, and when it no longer does", async () => {
    mockQueue.mockImplementation(async (_id, edits) =>
      (edits as { slug?: string }).slug === "my-post.v2" ? "Slug must be lowercase letters, digits and hyphens" : null
    );
    const { container, unmount } = renderTabWithUnmount();
    const slug = slugInput(container);

    await act(async () => {
      fireEvent.change(slug, { target: { value: "my-post" } });
    });
    expect(mockReportRefusal).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.change(slug, { target: { value: "my-post.v2" } });
    });
    expect(mockReportRefusal.mock.calls).toEqual([["p1", true]]);

    await act(async () => {
      fireEvent.change(slug, { target: { value: "my-post-v2" } });
    });
    expect(mockReportRefusal.mock.calls).toEqual([["p1", true], ["p1", false]]);

    await act(async () => {
      fireEvent.change(slug, { target: { value: "my-post.v2" } });
    });
    unmount();
    expect(mockReportRefusal.mock.calls.at(-1)).toEqual(["p1", false]);
  });

  it("reports an edit that could not reach the store", async () => {
    mockQueue.mockRejectedValue(new Error("ipc died"));
    const { container, titleInput, ref } = renderTab();
    await act(async () => {
      fireEvent.change(titleInput, { target: { value: "X" } });
    });

    let flushed: boolean | undefined;
    await act(async () => {
      flushed = await ref.current!.flushPendingChanges();
    });
    expect(flushed).toBe(false);
    expect(container.querySelector(".metadata-error")?.textContent)
      .toContain("Metadata could not be saved. Your edit is still shown; edit the field again to retry.");
  });
});

// The first .meta-field-generate button belongs to Title.
function titleGenerate(container: HTMLElement): HTMLButtonElement {
  return container.querySelector(".meta-field-generate") as HTMLButtonElement;
}

describe("MetadataTab single-field generation", () => {
  it("generates a field, writes the value, and sends it to the store", async () => {
    mockGenerateMetadataField.mockResolvedValue("AI Title");
    const { container, titleInput } = renderTab();

    await act(async () => {
      fireEvent.click(titleGenerate(container));
    });

    expect(mockGenerateMetadataField).toHaveBeenCalledWith("p1", "title", "some body text", expect.any(AbortSignal));
    expect(titleInput.value).toBe("AI Title");
    expect(mockQueue).toHaveBeenCalledWith("p1", { title: "AI Title" }, "w1");
  });

  it("turns the field's Generate into Stop while in flight", async () => {
    let release!: (value: string) => void;
    mockGenerateMetadataField.mockImplementation(
      () => new Promise<string>((resolve) => (release = resolve))
    );
    const { container } = renderTab();
    const btn = titleGenerate(container);

    await act(async () => {
      fireEvent.click(btn);
    });
    expect(btn.textContent).toBe("Stop");
    expect(btn.disabled).toBe(false);

    await act(async () => {
      release("done");
    });
    expect(btn.textContent).toBe("Generate");
  });

  it("Stop cancels the paid call and keeps the field unchanged", async () => {
    let signal: AbortSignal | undefined;
    mockGenerateMetadataField.mockImplementation(
      (_postId, _field, _content, s) =>
        new Promise<string>((_resolve, reject) => {
          signal = s;
          s?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    );
    const { container, titleInput } = renderTab();
    const btn = titleGenerate(container);
    await act(async () => {
      fireEvent.click(btn);
    });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(signal?.aborted).toBe(true);
    expect(btn.textContent).toBe("Generate");
    expect(titleInput.value).toBe("");
    expect(container.querySelector(".metadata-error")).toBeNull();
  });

  // Leaving the post must not queue behind a paid call.
  it("flushPendingChanges cancels an in-flight generation instead of waiting for it", async () => {
    let signal: AbortSignal | undefined;
    mockGenerateMetadataField.mockImplementation(
      (_postId, _field, _content, s) =>
        new Promise<string>((_resolve, reject) => {
          signal = s;
          s?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    );
    const { container, ref } = renderTab();
    await act(async () => {
      fireEvent.click(titleGenerate(container));
    });

    let flushed: boolean | undefined;
    await act(async () => {
      flushed = await ref.current!.flushPendingChanges();
    });

    expect(flushed).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it("surfaces a generation failure and does not save", async () => {
    mockGenerateMetadataField.mockRejectedValue(new Error("gen failed"));
    const { container } = renderTab();
    await act(async () => {
      fireEvent.click(titleGenerate(container));
    });
    expect(container.querySelector(".metadata-error")?.textContent)
      .toContain("Metadata could not be generated. Existing metadata is unchanged; try again.");
    expect(mockQueue).not.toHaveBeenCalled();
  });

  it("disables Generate when content is empty", () => {
    const { container } = renderTab({ content: "   " });
    expect(titleGenerate(container).disabled).toBe(true);
  });
});

describe("MetadataTab Generate All", () => {
  it("disables Generate All when content is empty", () => {
    const { container } = renderTab({ content: "" });
    const btn = container.querySelector(".btn-generate-all") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("reports fields the batch could not generate", async () => {
    // title + slug succeed; tags + metaDescription come back as errors.
    mockGenerateMetadataFields.mockResolvedValue({
      title: { value: "T" },
      slug: { value: "S" },
      tags: { error: "no tags" },
      metaDescription: { error: "no desc" },
    });
    const { container } = renderTab();
    await act(async () => {
      fireEvent.click(container.querySelector(".btn-generate-all") as HTMLButtonElement);
    });
    // The successful fields were sent to the store...
    expect(queuedEdits()).toEqual([{ title: "T" }, { slug: "S" }]);
    // ...and the failures are surfaced.
    expect(container.querySelector(".metadata-error")?.textContent).toContain(
      "Failed to generate: tags, metaDescription"
    );
  });

  it("reports a generated slug the store refused", async () => {
    mockGenerateMetadataFields.mockResolvedValue({
      title: { value: "T" },
      slug: { value: "taken" },
      tags: { value: "x, y" },
      metaDescription: { value: "D" },
    });
    mockQueue.mockImplementation(async (_id, edits) =>
      (edits as { slug?: string }).slug === "taken" ? 'Another post already uses the slug "taken"' : null
    );
    const { container } = renderTab();
    await act(async () => {
      fireEvent.click(container.querySelector(".btn-generate-all") as HTMLButtonElement);
    });
    expect(container.querySelector(".metadata-error")?.textContent).toContain("already uses the slug");
  });

  it("surfaces a failure when the whole batch generation rejects", async () => {
    mockGenerateMetadataFields.mockRejectedValue(new Error("provider down"));
    const { container } = renderTab();
    await act(async () => {
      fireEvent.click(container.querySelector(".btn-generate-all") as HTMLButtonElement);
    });
    expect(container.querySelector(".metadata-error")?.textContent)
      .toContain("Metadata could not be generated. Existing metadata is unchanged; try again.");
  });
});

describe("MetadataTab generation keeps what the user typed", () => {
  it("Generate All fills only the fields left untouched while it ran", async () => {
    let release!: (value: Record<string, { value: string }>) => void;
    mockGenerateMetadataFields.mockImplementation(
      () => new Promise((resolve) => (release = resolve))
    );
    const { container, titleInput } = renderTab();

    await act(async () => {
      fireEvent.click(container.querySelector(".btn-generate-all") as HTMLButtonElement);
    });
    fireEvent.change(titleInput, { target: { value: "My Own Title" } });
    await act(async () => {
      release({
        title: { value: "GenTitle" },
        slug: { value: "gen-slug" },
        tags: { value: "a, b" },
        metaDescription: { value: "GenDesc" },
      });
    });

    expect(titleInput.value).toBe("My Own Title");
    expect(slugInput(container).value).toBe("gen-slug");
    expect(queuedEdits()).not.toContainEqual({ title: "GenTitle" });
    expect(queuedEdits()).toContainEqual({ slug: "gen-slug" });
  });

  it("a single-field Generate drops its result when the field was typed into", async () => {
    let release!: (value: string) => void;
    mockGenerateMetadataField.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const { container, titleInput } = renderTab();

    await act(async () => {
      fireEvent.click(titleGenerate(container));
    });
    fireEvent.change(titleInput, { target: { value: "Typed" } });
    await act(async () => {
      release("GenTitle");
    });

    expect(titleInput.value).toBe("Typed");
    expect(queuedEdits()).not.toContainEqual({ title: "GenTitle" });
  });
});

describe("MetadataTab non-English fields", () => {
  function jaFrontMatter(): PostFrontMatter {
    return { ...frontMatter(), language: "ja", titleEn: "Seed En" };
  }

  it("renders the English companion fields and seeds them from front matter", () => {
    const { container } = renderTab({ frontMatter: jaFrontMatter() });
    // 8 fields: Title, Title(En), Slug, Tags, Tags(En), Description, Description(En), Extra.
    const textareas = container.querySelectorAll("textarea");
    expect(textareas).toHaveLength(8);
    expect((textareas[1] as HTMLTextAreaElement).value).toBe("Seed En");
  });

});

describe("MetadataTab read-only", () => {
  it("shows the read-only hint and ignores edits", async () => {
    const { container, titleInput, getByText } = renderReadOnly();
    expect(getByText("Metadata is read-only.")).toBeTruthy();

    await act(async () => {
      fireEvent.change(titleInput, { target: { value: "nope" } });
    });
    expect(mockQueue).not.toHaveBeenCalled();
    // Generate All and the per-field Generate are disabled.
    expect((container.querySelector(".btn-generate-all") as HTMLButtonElement).disabled).toBe(true);
    expect(titleGenerate(container).disabled).toBe(true);
  });

  function renderReadOnly() {
    const utils = renderTab({ readOnly: true });
    const getByText = (text: string) => {
      const el = Array.from(utils.container.querySelectorAll("*")).find(
        (n) => n.textContent === text
      );
      if (!el) throw new Error(`text not found: ${text}`);
      return el;
    };
    return { ...utils, getByText };
  }
});

describe("MetadataTab copy and error dismiss", () => {
  it("copies the Title value to the clipboard and flips the label", async () => {
    const { container, titleInput } = renderTab();
    fireEvent.change(titleInput, { target: { value: "Copy me" } });
    const copyBtn = container.querySelector(".meta-field-copy") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(copyBtn);
    });
    expect(clipboardWrite).toHaveBeenCalledWith("Copy me");
    expect(copyBtn.textContent?.trim()).toBe("Copied");
    expect(copyBtn.querySelector("svg")?.dataset.icon).toBe("check");
  });

  it("keeps a failed copy inside the affected metadata field", async () => {
    clipboardWrite.mockRejectedValueOnce(new Error("denied"));
    const { container } = renderTab();
    const titleField = container.querySelector(".meta-field") as HTMLElement;

    await act(async () => {
      fireEvent.click(titleField.querySelector(".meta-field-copy") as HTMLButtonElement);
    });

    const result = titleField.querySelector('[role="alert"]');
    expect(result?.textContent).toContain("Could not copy to the clipboard");
    expect(result?.querySelector('[data-icon="error"]')).toBeNull();
  });

  it("dismisses the generation error banner", async () => {
    mockGenerateMetadataField.mockRejectedValue(new Error("boom"));
    const { container } = renderTab();
    await act(async () => {
      fireEvent.click(titleGenerate(container));
    });
    expect(container.querySelector(".metadata-error")).toBeTruthy();
    fireEvent.click(container.querySelector(".metadata-error-dismiss") as HTMLButtonElement);
    expect(container.querySelector(".metadata-error")).toBeNull();
  });
});
