import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { createRef } from "react";

// MetadataTab only talks to the main process through these three api calls.
vi.mock("@renderer/api", () => ({
  updatePost: vi.fn(),
  generateMetadataField: vi.fn(),
  generateMetadataFields: vi.fn(),
}));

import { MetadataTab, type MetadataTabHandle } from "@renderer/components/MetadataTab";
import { updatePost, generateMetadataField, generateMetadataFields } from "@renderer/api";
import type { PostFrontMatter, PostMutationResult } from "@shared/types";

const AUTOSAVE_DELAY_MS = 1_000;
const mockUpdatePost = vi.mocked(updatePost);
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

function result(): PostMutationResult {
  const fm = frontMatter();
  return { frontMatter: fm, content: "", summary: fm };
}

// A deferred updatePost: each call parks a resolver the test fires later, so a
// save can be held in flight while the user keeps editing.
function deferUpdatePost(resolvers: Array<() => void>) {
  mockUpdatePost.mockImplementation(
    () =>
      new Promise<PostMutationResult>((resolve) => {
        resolvers.push(() => resolve(result()));
      })
  );
}

// Resolve in-flight saves (and any issued later) until `pending` settles. The
// flush drain loop and Generate All issue a variable number of saves, so the
// test resolves whatever is queued rather than a fixed count; re-resolving an
// already-settled promise is a no-op.
async function settleSaves(resolvers: Array<() => void>, pending: Promise<unknown>) {
  let done = false;
  void pending.then(() => {
    done = true;
  });
  for (let guard = 0; !done && guard < 100; guard += 1) {
    resolvers.forEach((resolve) => resolve());
    await Promise.resolve();
  }
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
  const onPostUpdated = vi.fn();
  const { container } = render(
    <MetadataTab
      ref={ref}
      workspaceId="w1"
      postId="p1"
      frontMatter={overrides.frontMatter ?? frontMatter()}
      content={overrides.content ?? "some body text"}
      extraFieldWatermark={overrides.extraFieldWatermark ?? ""}
      onPostUpdated={onPostUpdated}
      readOnly={overrides.readOnly}
    />
  );
  // The Title field is the first textarea rendered.
  const titleInput = container.querySelectorAll("textarea")[0] as HTMLTextAreaElement;
  return { ref, container, titleInput, onPostUpdated };
}

// The Copy buttons go through useCopyFeedback → navigator.clipboard.
let clipboardWrite: ReturnType<typeof vi.fn>;
let originalClipboard: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  mockUpdatePost.mockReset();
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
  vi.useRealTimers();
  if (originalClipboard) {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  } else {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
});

describe("MetadataTab autosave", () => {
  it("persists a field edit after the debounce", async () => {
    mockUpdatePost.mockResolvedValue(result());
    const { titleInput } = renderTab();

    fireEvent.change(titleInput, { target: { value: "Hello" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    });

    expect(mockUpdatePost).toHaveBeenCalledWith("p1", { frontMatter: { title: "Hello" } }, "w1");
  });

  it("does not lose a newer edit when an older save resolves mid-flight before flush", async () => {
    // Make each save controllable so the first save can stay in flight while the
    // user edits again.
    const resolvers: Array<() => void> = [];
    mockUpdatePost.mockImplementation(() => {
      return new Promise<PostMutationResult>((resolve) => {
        resolvers.push(() => resolve(result()));
      });
    });

    const { ref, titleInput } = renderTab();

    // Type "A" and let its debounce fire — save A is now in flight.
    fireEvent.change(titleInput, { target: { value: "A" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    });
    expect(resolvers).toHaveLength(1);

    // Edit to "B" before A's save resolves and before B's debounce fires.
    fireEvent.change(titleInput, { target: { value: "B" } });

    // The stale "A" save resolves. It must NOT clear the dirty flag, because the
    // field already holds the newer "B".
    await act(async () => {
      resolvers[0]();
    });

    // Switching posts flushes: it cancels B's pending timer, so flush itself must
    // persist the newer "B".
    let flushed: boolean | undefined;
    await act(async () => {
      const pending = ref.current!.flushPendingChanges();
      resolvers[1]?.(); // resolve the flush's save of "B"
      flushed = await pending;
    });

    expect(flushed).toBe(true);
    expect(mockUpdatePost).toHaveBeenCalledTimes(2);
    expect(mockUpdatePost.mock.calls.at(-1)?.[1]).toEqual({ frontMatter: { title: "B" } });
  });

  it("does not drop an edit made while Generate All's batch save is in flight", async () => {
    const resolvers: Array<() => void> = [];
    deferUpdatePost(resolvers);
    // Generation returns immediately with a value for every English field.
    mockGenerateMetadataFields.mockResolvedValue({
      title: { value: "GenTitle" },
      slug: { value: "GenSlug" },
      tags: { value: "GenTags" },
      metaDescription: { value: "GenDesc" },
    });

    const { ref, container, titleInput } = renderTab();
    const generateAll = container.querySelector(".btn-generate-all") as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(generateAll);
      // Wait until the batch save is actually issued (generation resolved and
      // setFields ran), then edit the Title before that save resolves.
      for (let i = 0; i < 50 && mockUpdatePost.mock.calls.length < 1; i += 1) {
        await Promise.resolve();
      }
      fireEvent.change(titleInput, { target: { value: "User Edit" } });
      resolvers[0]();
    });

    // The batch save recorded the generated Title, but the field now holds the
    // user's newer value, so it must stay dirty and a flush must persist it —
    // the unconditional dirty-clear in the old batch path would have lost it.
    let flushed: boolean | undefined;
    await act(async () => {
      const pending = ref.current!.flushPendingChanges();
      await settleSaves(resolvers, pending);
      flushed = await pending;
    });

    expect(flushed).toBe(true);
    expect(mockUpdatePost.mock.calls.at(-1)?.[1]).toEqual({
      frontMatter: { title: "User Edit" },
    });
  });

  it("flush keeps saving until no field is dirty when an edit lands mid-flush", async () => {
    const resolvers: Array<() => void> = [];
    deferUpdatePost(resolvers);
    const { ref, titleInput } = renderTab();

    fireEvent.change(titleInput, { target: { value: "A" } });

    let flushed: boolean | undefined;
    await act(async () => {
      // flushPendingChanges issues the save of "A" synchronously; edit to "B"
      // before it resolves so the field is dirty again when the save lands. The
      // drain loop must notice and persist "B" before reporting success.
      const pending = ref.current!.flushPendingChanges();
      fireEvent.change(titleInput, { target: { value: "B" } });
      await settleSaves(resolvers, pending);
      flushed = await pending;
    });

    expect(flushed).toBe(true);
    expect(mockUpdatePost).toHaveBeenCalledTimes(2);
    expect(mockUpdatePost.mock.calls.at(-1)?.[1]).toEqual({ frontMatter: { title: "B" } });
  });

  it("blur fast-forwards the debounce and saves immediately", async () => {
    mockUpdatePost.mockResolvedValue(result());
    const { titleInput } = renderTab();

    fireEvent.change(titleInput, { target: { value: "Blurred" } });
    await act(async () => {
      // No timer advance — blur should persist before the debounce elapses.
      fireEvent.blur(titleInput);
    });
    expect(mockUpdatePost).toHaveBeenCalledWith("p1", { frontMatter: { title: "Blurred" } }, "w1");
  });

  it("blur does not save a field that is unchanged", async () => {
    mockUpdatePost.mockResolvedValue(result());
    const { titleInput } = renderTab();
    await act(async () => {
      fireEvent.blur(titleInput);
    });
    expect(mockUpdatePost).not.toHaveBeenCalled();
  });

  it("normalizes tags into an array on save", async () => {
    mockUpdatePost.mockResolvedValue(result());
    const { container } = renderTab();
    // Field order (en): Title, Slug, Tags, Description, Extra.
    const tagsInput = container.querySelectorAll("textarea")[2] as HTMLTextAreaElement;
    fireEvent.change(tagsInput, { target: { value: "a, b ,, c" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    });
    expect(mockUpdatePost).toHaveBeenCalledWith("p1", { frontMatter: { tags: ["a", "b", "c"] } }, "w1");
  });

  it("surfaces a save failure in the error banner", async () => {
    mockUpdatePost.mockRejectedValue(new Error("save died"));
    const { container, titleInput } = renderTab();
    fireEvent.change(titleInput, { target: { value: "X" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    });
    expect(container.querySelector(".metadata-error")?.textContent).toContain("save died");
  });
});

// The first .meta-field-generate button belongs to Title.
function titleGenerate(container: HTMLElement): HTMLButtonElement {
  return container.querySelector(".meta-field-generate") as HTMLButtonElement;
}

describe("MetadataTab single-field generation", () => {
  it("generates a field, writes the value, and persists it", async () => {
    mockGenerateMetadataField.mockResolvedValue("AI Title");
    mockUpdatePost.mockResolvedValue(result());
    const { container, titleInput } = renderTab();

    await act(async () => {
      fireEvent.click(titleGenerate(container));
    });

    expect(mockGenerateMetadataField).toHaveBeenCalledWith("p1", "title", "some body text");
    expect(titleInput.value).toBe("AI Title");
    expect(mockUpdatePost).toHaveBeenCalledWith("p1", { frontMatter: { title: "AI Title" } }, "w1");
  });

  it("shows the field's generating label while in flight", async () => {
    let release!: (value: string) => void;
    mockGenerateMetadataField.mockImplementation(
      () => new Promise<string>((resolve) => (release = resolve))
    );
    mockUpdatePost.mockResolvedValue(result());
    const { container } = renderTab();
    const btn = titleGenerate(container);

    await act(async () => {
      fireEvent.click(btn);
    });
    expect(btn.textContent).toBe("Generating…");
    expect(btn.disabled).toBe(true);

    await act(async () => {
      release("done");
    });
    expect(btn.textContent).toBe("Generate");
  });

  it("surfaces a generation failure and does not save", async () => {
    mockGenerateMetadataField.mockRejectedValue(new Error("gen failed"));
    const { container } = renderTab();
    await act(async () => {
      fireEvent.click(titleGenerate(container));
    });
    expect(container.querySelector(".metadata-error")?.textContent).toContain("gen failed");
    expect(mockUpdatePost).not.toHaveBeenCalled();
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
    mockUpdatePost.mockResolvedValue(result());
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
    // The successful fields were saved in a single batch update...
    expect(mockUpdatePost).toHaveBeenCalledWith(
      "p1",
      { frontMatter: { title: "T", slug: "S" } },
      "w1"
    );
    // ...and the failures are surfaced.
    expect(container.querySelector(".metadata-error")?.textContent).toContain(
      "Failed to generate: tags, metaDescription"
    );
  });

  it("surfaces a failure when the batch save itself fails", async () => {
    mockGenerateMetadataFields.mockResolvedValue({
      title: { value: "T" },
      slug: { value: "S" },
      tags: { value: "x, y" },
      metaDescription: { value: "D" },
    });
    mockUpdatePost.mockRejectedValue(new Error("batch save died"));
    const { container } = renderTab();
    await act(async () => {
      fireEvent.click(container.querySelector(".btn-generate-all") as HTMLButtonElement);
    });
    expect(container.querySelector(".metadata-error")?.textContent).toContain("batch save died");
  });

  it("surfaces a failure when the whole batch generation rejects", async () => {
    mockGenerateMetadataFields.mockRejectedValue(new Error("provider down"));
    const { container } = renderTab();
    await act(async () => {
      fireEvent.click(container.querySelector(".btn-generate-all") as HTMLButtonElement);
    });
    expect(container.querySelector(".metadata-error")?.textContent).toContain("provider down");
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

  it("autosaves an edit to the Title (English) companion field", async () => {
    mockUpdatePost.mockResolvedValue(result());
    const { container } = renderTab({ frontMatter: jaFrontMatter() });
    const titleEn = container.querySelectorAll("textarea")[1] as HTMLTextAreaElement;
    fireEvent.change(titleEn, { target: { value: "New En" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    });
    expect(mockUpdatePost).toHaveBeenCalledWith("p1", { frontMatter: { titleEn: "New En" } }, "w1");
  });
});

describe("MetadataTab read-only", () => {
  it("shows the read-only hint and ignores edits", async () => {
    const { container, titleInput, getByText } = renderReadOnly();
    expect(getByText("Metadata is read-only.")).toBeTruthy();

    fireEvent.change(titleInput, { target: { value: "nope" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    });
    expect(mockUpdatePost).not.toHaveBeenCalled();
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
    expect(copyBtn.textContent).toBe("✓ Copied");
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
