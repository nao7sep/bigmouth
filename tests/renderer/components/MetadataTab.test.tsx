import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent, within } from "@testing-library/react";
import { createRef } from "react";

// MetadataTab only talks to the main process through these api calls.
// A held edit's late refusal arrives as an event; tests play main's part.
const refusedListeners = vi.hoisted(
  () => new Set<(e: { postId: string; edits: Record<string, unknown>; refusal: unknown }) => void>()
);
vi.mock("@renderer/api", () => ({
  reportProblem: vi.fn(),
  queuePostMetadata: vi.fn(),
  reportMetadataRefusal: vi.fn(),
  onPostMetadataRefused: (cb: (e: { postId: string; edits: Record<string, unknown>; refusal: unknown }) => void) => {
    refusedListeners.add(cb);
    return () => refusedListeners.delete(cb);
  },
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
    locked: boolean;
    extraFieldWatermark: string;
    onUnsavedChange: (unsaved: boolean) => void;
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
      locked={overrides.locked}
      onUnsavedChange={overrides.onUnsavedChange}
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
      fireEvent.change(tagsInput, { target: { value: "a,b\n c、d \n\nlast" } });
    });
    expect(mockQueue).toHaveBeenCalledWith("p1", { tags: ["a,b", "c、d", "last"] }, "w1");
    expect(tagsInput.value).toBe("a,b\n c、d \n\nlast");
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
      (edits as { slug?: string }).slug === "taken" ? { key: "metadata.refusedSlugTaken", values: { slug: "taken" } } : null
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
  // Held while storage was busy, the edit was answered as buffered; the store
  // refused it once storage took it, so the field must say so and quit must ask.
  it("records a held edit's late refusal for the field still showing that value", async () => {
    mockQueue.mockResolvedValue(null);
    const { container, ref } = renderTab();
    const slug = slugInput(container);
    await act(async () => {
      fireEvent.change(slug, { target: { value: "taken" } });
    });
    expect(mockReportRefusal).not.toHaveBeenCalled();

    const refusal = { key: "metadata.refusedSlugTaken", values: { slug: "taken" } };
    act(() => {
      refusedListeners.forEach((cb) => cb({ postId: "other", edits: { slug: "taken" }, refusal }));
    });
    expect(mockReportRefusal).not.toHaveBeenCalled();
    act(() => {
      refusedListeners.forEach((cb) => cb({ postId: "p1", edits: { slug: "taken" }, refusal }));
    });
    expect(mockReportRefusal.mock.calls).toEqual([["p1", true]]);
    expect(container.querySelector(".metadata-error")?.textContent).toContain("already uses the slug");
    let flushed: boolean | undefined;
    await act(async () => {
      flushed = await ref.current!.flushPendingChanges();
    });
    expect(flushed).toBe(false);
  });

  it("ignores a late refusal for a value the field no longer shows", async () => {
    mockQueue.mockResolvedValue(null);
    const { container } = renderTab();
    const slug = slugInput(container);
    await act(async () => {
      fireEvent.change(slug, { target: { value: "taken" } });
      fireEvent.change(slug, { target: { value: "taken-2" } });
    });
    act(() => {
      refusedListeners.forEach((cb) =>
        cb({ postId: "p1", edits: { slug: "taken" }, refusal: { key: "metadata.refusedSlugTaken", values: { slug: "taken" } } })
      );
    });
    expect(mockReportRefusal).not.toHaveBeenCalled();
    expect(container.querySelector(".metadata-error")).toBeNull();
  });

  it("tells main while a field shows a refused value, and when it no longer does", async () => {
    mockQueue.mockImplementation(async (_id, edits) =>
      (edits as { slug?: string }).slug === "my-post.v2" ? { key: "metadata.refusedInvalidSlug", values: { max: 200 } } : null
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
    // Named as the tab names them, in the language's own list form.
    expect(container.querySelector(".metadata-error")?.textContent).toContain(
      "These fields could not be generated: Tags, Description."
    );
  });

  it("reports a generated slug the store refused", async () => {
    mockGenerateMetadataFields.mockResolvedValue({
      title: { value: "T" },
      slug: { value: "taken" },
      tags: { value: ["x", "y"] },
      metaDescription: { value: "D" },
    });
    mockQueue.mockImplementation(async (_id, edits) =>
      (edits as { slug?: string }).slug === "taken" ? { key: "metadata.refusedSlugTaken", values: { slug: "taken" } } : null
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
    let release!: (value: Record<string, { value: string | string[] }>) => void;
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
        tags: { value: ["a", "b"] },
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

describe("MetadataTab locked", () => {
  it("shows the locked hint and ignores edits", async () => {
    const { container, titleInput, getByText } = renderLocked();
    expect(getByText("Metadata is locked.")).toBeTruthy();

    await act(async () => {
      fireEvent.change(titleInput, { target: { value: "nope" } });
    });
    expect(mockQueue).not.toHaveBeenCalled();
    // Generate All and the per-field Generate are disabled.
    expect((container.querySelector(".btn-generate-all") as HTMLButtonElement).disabled).toBe(true);
    expect(titleGenerate(container).disabled).toBe(true);
  });

  function renderLocked() {
    const utils = renderTab({ locked: true });
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

it("names each metadata textbox with its visible label", () => {
  const { container } = renderTab({ frontMatter: { ...frontMatter(), language: "ja" } });
  for (const name of ["Title", "Title (English)", "Slug", "Tags", "Tags (English)", "Description", "Description (English)", "Extra"]) {
    expect(within(container).getByRole("textbox", { name })).toBe(within(container).getByLabelText(name, { exact: true }));
  }
});


describe("MetadataTab tag arrays", () => {
  const generatedTags = ["spring, garden", "soil、planting", "seeds"];

  it("shows generated tags on separate lines and queues the original array", async () => {
    mockGenerateMetadataField.mockResolvedValue(generatedTags);
    const { container, onMetadataEdited } = renderTab();
    const tags = within(container).getByRole("textbox", { name: "Tags" }) as HTMLTextAreaElement;
    const field = tags.closest(".meta-field")!;
    await act(async () => {
      fireEvent.click(field.querySelector(".meta-field-generate")!);
    });
    expect(tags.value).toBe(generatedTags.join("\n"));
    expect(mockQueue).toHaveBeenCalledWith("p1", { tags: generatedTags }, "w1");
    expect((mockQueue.mock.calls[0][1] as { tags: string[] }).tags).toBe(generatedTags);
    expect(onMetadataEdited).toHaveBeenCalledWith("p1", { tags: generatedTags });
  });

  it("queues the original generated tag array in Generate All", async () => {
    mockGenerateMetadataFields.mockResolvedValue({
      title: { value: "T" }, slug: { value: "slug" },
      tags: { value: generatedTags }, metaDescription: { value: "D" },
    });
    const { container } = renderTab();
    await act(async () => { fireEvent.click(container.querySelector(".btn-generate-all")!); });
    const tags = within(container).getByRole("textbox", { name: "Tags" }) as HTMLTextAreaElement;
    expect(tags.value).toBe(generatedTags.join("\n"));
    const edit = queuedEdits().find((value) => "tags" in value)!;
    expect(edit.tags).toBe(generatedTags);
  });

  it.each(["single", "all"])("keeps typed tags when %s generation finishes", async (mode) => {
    let release!: () => void;
    if (mode === "single") {
      mockGenerateMetadataField.mockImplementation(() => new Promise((resolve) => {
        release = () => resolve(generatedTags);
      }));
    } else {
      mockGenerateMetadataFields.mockImplementation(() => new Promise((resolve) => {
        release = () => resolve({ tags: { value: generatedTags } });
      }));
    }
    const { container } = renderTab();
    const tags = within(container).getByRole("textbox", { name: "Tags" }) as HTMLTextAreaElement;
    const button = mode === "single"
      ? tags.closest(".meta-field")!.querySelector(".meta-field-generate")!
      : container.querySelector(".btn-generate-all")!;
    await act(async () => { fireEvent.click(button); });
    await act(async () => { fireEvent.change(tags, { target: { value: "my, tag\nmy、other tag" } }); });
    await act(async () => { release(); });
    expect(tags.value).toBe("my, tag\nmy、other tag");
    expect(queuedEdits()).toContainEqual({ tags: ["my, tag", "my、other tag"] });
    expect(queuedEdits()).not.toContainEqual({ tags: generatedTags });
  });
});

function renderRefreshingMetadata(initial: PostFrontMatter = frontMatter()) {
  const onMetadataEdited = vi.fn();
  const element = (frontMatter: PostFrontMatter, locked = false) => <MetadataTab
    workspaceId="w1" postId="p1" frontMatter={frontMatter} content="some body text"
    extraFieldWatermark="" onMetadataEdited={onMetadataEdited} locked={locked}
  />;
  const view = render(element(initial));
  return { ...view, refresh: (frontMatter: PostFrontMatter, locked = false) => view.rerender(element(frontMatter, locked)) };
}

describe("MetadataTab canonical refresh", () => {
  it("adopts outside changes in untouched fields without queuing them", () => {
    const view = renderRefreshingMetadata();
    view.refresh({ ...frontMatter(), title: "Outside title", slug: "outside", tags: ["one", "two"], extra: "outside extra" });
    expect((view.getByRole("textbox", { name: "Title" }) as HTMLTextAreaElement).value).toBe("Outside title");
    expect((view.getByRole("textbox", { name: "Slug" }) as HTMLTextAreaElement).value).toBe("outside");
    expect((view.getByRole("textbox", { name: "Tags" }) as HTMLTextAreaElement).value).toBe("one\ntwo");
    expect((view.getByRole("textbox", { name: "Extra" }) as HTMLTextAreaElement).value).toBe("outside extra");
    expect(mockQueue).not.toHaveBeenCalled();
  });

  it("retains an in-flight local field while refreshing unrelated untouched fields", async () => {
    let accept!: (refusal: null) => void;
    mockQueue.mockReturnValueOnce(new Promise((resolve) => { accept = resolve; }));
    const view = renderRefreshingMetadata();
    const title = view.getByRole("textbox", { name: "Title" }) as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: "My pending title" } });
    view.refresh({ ...frontMatter(), title: "Outside title", slug: "outside" });
    expect(title.value).toBe("My pending title");
    expect((view.getByRole("textbox", { name: "Slug" }) as HTMLTextAreaElement).value).toBe("outside");
    expect(mockQueue).toHaveBeenCalledOnce();
    await act(async () => { accept(null); });
    view.refresh({ ...frontMatter(), title: "Still older than my edit" });
    expect(title.value).toBe("My pending title");
    expect(mockQueue).toHaveBeenCalledOnce();
  });

  it("keeps raw formatting for an accepted snapshot, then adopts a later external value", async () => {
    const view = renderRefreshingMetadata();
    const title = view.getByRole("textbox", { name: "Title" }) as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: " My\n  title " } });
    await act(async () => { await Promise.resolve(); });
    view.refresh({ ...frontMatter(), title: "My title" });
    expect(title.value).toBe(" My\n  title ");
    view.refresh({ ...frontMatter(), title: "A later outside title" });
    expect(title.value).toBe("A later outside title");
    expect(mockQueue).toHaveBeenCalledOnce();
  });

  it("retains a refused value even after an accepted snapshot previously released its dirty marker", async () => {
    const view = renderRefreshingMetadata();
    const slug = view.getByRole("textbox", { name: "Slug" }) as HTMLTextAreaElement;
    fireEvent.change(slug, { target: { value: "taken" } });
    await act(async () => { await Promise.resolve(); });
    view.refresh({ ...frontMatter(), slug: "taken" });
    act(() => {
      refusedListeners.forEach((cb) => cb({ postId: "p1", edits: { slug: "taken" }, refusal: { key: "metadata.refusedSlugTaken", values: { slug: "taken" } } }));
    });
    view.refresh({ ...frontMatter(), slug: "other-canonical-slug" });
    expect(slug.value).toBe("taken");
    expect(view.getByRole("alert").textContent).toContain('Another post already uses the slug "taken"');
    expect(mockQueue).toHaveBeenCalledOnce();
  });

  it("retains a failed edit through canonical updates", async () => {
    mockQueue.mockRejectedValueOnce(new Error("queue unavailable"));
    const view = renderRefreshingMetadata();
    const title = view.getByRole("textbox", { name: "Title" }) as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: "Unsaved title" } });
    await act(async () => { await Promise.resolve(); });
    view.refresh({ ...frontMatter(), title: "Unsaved title" });
    view.refresh({ ...frontMatter(), title: "Outside title" });
    expect(title.value).toBe("Unsaved title");
    expect(mockQueue).toHaveBeenCalledOnce();
  });

  it("marks generated fields dirty so a stale canonical refresh cannot overwrite them", async () => {
    mockGenerateMetadataField.mockResolvedValue("Generated title");
    const view = renderRefreshingMetadata();
    const title = view.getByRole("textbox", { name: "Title" }) as HTMLTextAreaElement;
    const field = title.closest(".meta-field") as HTMLElement;
    await act(async () => { fireEvent.click(within(field).getByRole("button", { name: "Generate" })); });
    view.refresh({ ...frontMatter(), title: "Old canonical title" });
    expect(title.value).toBe("Generated title");
    expect(mockQueue).toHaveBeenCalledOnce();
    view.refresh({ ...frontMatter(), title: "Generated title" });
    view.refresh({ ...frontMatter(), title: "New external title" });
    expect(title.value).toBe("New external title");
  });

  it("locks editing and generation while retaining local text and refreshing untouched fields", () => {
    const view = renderRefreshingMetadata();
    const title = view.getByRole("textbox", { name: "Title" }) as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: "Typed before lock" } });
    view.refresh({ ...frontMatter(), title: "Outside title", slug: "new-slug" }, true);
    expect(title.value).toBe("Typed before lock");
    expect(title.readOnly).toBe(true);
    expect((view.getByRole("textbox", { name: "Slug" }) as HTMLTextAreaElement).value).toBe("new-slug");
    expect((view.getByRole("button", { name: "Generate All" }) as HTMLButtonElement).disabled).toBe(true);
    for (const button of view.getAllByRole("button", { name: "Generate" })) expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(title, { target: { value: "Blocked change" } });
    expect(title.value).toBe("Typed before lock");
    expect(mockQueue).toHaveBeenCalledOnce();
  });
});

it("reports admission lifetime synchronously and retains rescue until every round and refusal is resolved", async () => {
  const rounds: Array<{ resolve: (value: null) => void; reject: (error: Error) => void }> = [];
  mockQueue.mockImplementation(() => new Promise((resolve, reject) => { rounds.push({ resolve, reject }); }));
  const onUnsavedChange = vi.fn();
  const { titleInput } = renderTab({ onUnsavedChange });
  fireEvent.change(titleInput, { target: { value: "First" } });
  expect(onUnsavedChange).toHaveBeenCalledExactlyOnceWith(true);
  fireEvent.change(titleInput, { target: { value: "Second" } });
  await act(async () => { rounds[0]!.resolve(null); });
  expect(onUnsavedChange.mock.calls).toEqual([[true]]);
  await act(async () => { rounds[1]!.reject(new Error("queue failed")); });
  expect(onUnsavedChange.mock.calls).toEqual([[true]]);
  fireEvent.change(titleInput, { target: { value: "Correction" } });
  await act(async () => { rounds[2]!.resolve(null); });
  expect(onUnsavedChange.mock.calls).toEqual([[true], [false]]);
});
