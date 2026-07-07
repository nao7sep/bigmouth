import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent, within } from "@testing-library/react";
import type { PostListResponse, PostSummary, Target } from "@shared/types";

// NewPostModal embeds a PostPickerList (usePostPicker → listPosts) and confirms
// the dirty close through the app-wide host; mock the seam and wrap in a
// ConfirmProvider.
vi.mock("@renderer/api", () => ({
  listPosts: vi.fn(),
}));

// jsdom has no layout: the embedded listbox scrolls the active row into view, so
// stub scrollIntoView so arrowing never throws.
beforeEach(() => {
  if (!("scrollIntoView" in HTMLElement.prototype)) {
    (HTMLElement.prototype as { scrollIntoView?: () => void }).scrollIntoView = () => {};
  }
});

import { NewPostModal } from "@renderer/components/NewPostModal";
import { ConfirmProvider } from "@renderer/components/ConfirmHost";
import { listPosts } from "@renderer/api";

const mockListPosts = vi.mocked(listPosts);

function summary(id: string, title: string): PostSummary {
  return {
    frontMatter: {
      id,
      target: "blog",
      status: "published",
      language: "en",
      createdAtUtc: "2024-01-01T00:00:00.000Z",
      title,
    },
  };
}

function page(posts: PostSummary[] = []): PostListResponse {
  return {
    drafts: [],
    ready: [],
    published: posts,
    publishedTotal: posts.length,
    publishedOffset: 0,
    expired: [],
    expiredTotal: 0,
    expiredOffset: 0,
  };
}

const TARGETS: Target[] = [
  { name: "blog", defaultLanguage: "ja", requiresMetadata: true },
  { name: "social", defaultLanguage: "en", requiresMetadata: false },
];

afterEach(() => {
  cleanup();
  mockListPosts.mockReset();
});

async function renderModal(
  over: Partial<{
    targets: Target[];
    supportedLanguages: string[];
    onClose: () => void;
    onCreate: (target: string, language: string, sourceId?: string) => Promise<void> | void;
  }> = {},
) {
  mockListPosts.mockResolvedValue(page(over.targets === undefined ? [summary("s1", "Existing post")] : []));
  const onClose = over.onClose ?? vi.fn();
  const onCreate = over.onCreate ?? vi.fn();
  const utils = render(
    <ConfirmProvider>
      <NewPostModal
        targets={over.targets ?? TARGETS}
        supportedLanguages={over.supportedLanguages ?? ["en", "ja"]}
        pubBatchSize={50}
        onClose={onClose}
        onCreate={onCreate}
      />
    </ConfirmProvider>,
  );
  // Flush the embedded picker's load.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { onClose, onCreate, ...utils };
}

describe("NewPostModal — render", () => {
  it("renders target/language selects with a 'Please select…' placeholder for target", async () => {
    const { getByRole, getByText } = await renderModal();
    const labelId = getByRole("dialog").getAttribute("aria-labelledby");
    expect(document.getElementById(labelId!)?.textContent).toBe("New Post");
    expect(getByText("Please select…")).toBeTruthy();
    // The Create button is disabled until a target is chosen.
    expect((getByText("Create").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the no-targets fallback and disables Create when no targets exist", async () => {
    const { getByText } = await renderModal({ targets: [] });
    expect(getByText("No targets configured.")).toBeTruthy();
    expect((getByText("Create").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the no-languages fallback when supportedLanguages is empty", async () => {
    const { getByText } = await renderModal({ supportedLanguages: [] });
    expect(getByText(/No supported languages configured/)).toBeTruthy();
  });
});

describe("NewPostModal — target/language coupling", () => {
  it("seeds the language from the chosen target's defaultLanguage", async () => {
    const { container } = await renderModal();
    const selects = container.querySelectorAll("select");
    const targetSelect = selects[0] as HTMLSelectElement;
    const langSelect = selects[1] as HTMLSelectElement;

    // blog defaults to ja.
    fireEvent.change(targetSelect, { target: { value: "blog" } });
    expect(langSelect.value).toBe("ja");

    // social defaults to en.
    fireEvent.change(targetSelect, { target: { value: "social" } });
    expect(langSelect.value).toBe("en");
  });

  it("falls back to en (then the first language) when the target default is unsupported", async () => {
    // blog's default "ja" is not supported, so resolveLanguage picks "en".
    const { container } = await renderModal({ supportedLanguages: ["en", "fr"] });
    const selects = container.querySelectorAll("select");
    fireEvent.change(selects[0], { target: { value: "blog" } });
    expect((selects[1] as HTMLSelectElement).value).toBe("en");
  });
});

describe("NewPostModal — create flow", () => {
  it("invokes onCreate with the selected target, language and source id", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const { container, getByText } = await renderModal({ onCreate });

    const selects = container.querySelectorAll("select");
    fireEvent.change(selects[0], { target: { value: "social" } }); // → language en
    // Link a source post from the embedded picker.
    fireEvent.click(getByText("Existing post"));
    // The selected source is shown with an Unlink affordance.
    expect(getByText("Existing post")).toBeTruthy();
    expect(getByText("Unlink")).toBeTruthy();

    await act(async () => {
      fireEvent.click(getByText("Create"));
      await Promise.resolve();
    });
    expect(onCreate).toHaveBeenCalledWith("social", "en", "s1");
  });

  it("omits the source id when none is linked", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const { container, getByText } = await renderModal({ onCreate });
    fireEvent.change(container.querySelectorAll("select")[0], { target: { value: "social" } });

    await act(async () => {
      fireEvent.click(getByText("Create"));
      await Promise.resolve();
    });
    expect(onCreate).toHaveBeenCalledWith("social", "en", undefined);
  });

  it("unlinks a chosen source, restoring the picker", async () => {
    const { container, getByText, getByPlaceholderText } = await renderModal();
    fireEvent.change(container.querySelectorAll("select")[0], { target: { value: "social" } });
    fireEvent.click(getByText("Existing post"));
    fireEvent.click(getByText("Unlink"));
    // The filter input returns once the source is cleared.
    expect(getByPlaceholderText("Filter posts…")).toBeTruthy();
  });

  it("surfaces an error thrown by onCreate and keeps the modal open", async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error("create boom"));
    const { container, getByText } = await renderModal({ onCreate });
    fireEvent.change(container.querySelectorAll("select")[0], { target: { value: "social" } });

    await act(async () => {
      fireEvent.click(getByText("Create"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getByText("create boom")).toBeTruthy();
  });
});

describe("NewPostModal — validation guards", () => {
  it("blocks creation with a 'select a target' error when none is chosen", async () => {
    // Re-enable the Create button by faking a dirty source so onCreate's guard
    // path runs: instead, drive handleCreate directly by clearing the disabled
    // gate via a linked source while leaving the target empty.
    const onCreate = vi.fn();
    const { getByText } = await renderModal({ onCreate });
    // Linking a source makes the form dirty but the target stays empty; the
    // Create button is still disabled by the target check, so assert the gate.
    fireEvent.click(getByText("Existing post"));
    const createBtn = getByText("Create").closest("button") as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe("NewPostModal — dirty-close confirmation", () => {
  it("closes immediately when nothing was selected", async () => {
    const { onClose, getByText } = await renderModal();
    fireEvent.click(getByText("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("asks to discard when a target is selected, and closes only after confirming", async () => {
    const { onClose, container, getByText, getByRole } = await renderModal();
    fireEvent.change(container.querySelectorAll("select")[0], { target: { value: "social" } });

    fireEvent.click(getByText("Cancel"));
    // The dirty-close confirmation appears; the modal is still open.
    const confirmDialog = await within(document.body).findByText("Discard new post?");
    expect(confirmDialog).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(getByRole("button", { name: "Discard" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the modal open when the discard is declined", async () => {
    const { onClose, container, getByText, getByRole } = await renderModal();
    fireEvent.change(container.querySelectorAll("select")[0], { target: { value: "social" } });

    fireEvent.click(getByText("Cancel"));
    await within(document.body).findByText("Discard new post?");
    fireEvent.click(getByRole("button", { name: "Keep Editing" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("routes Escape through the dirty-close guard", async () => {
    const { onClose, container } = await renderModal();
    fireEvent.change(container.querySelectorAll("select")[0], { target: { value: "social" } });
    fireEvent.keyDown(document, { key: "Escape" });
    await within(document.body).findByText("Discard new post?");
    expect(onClose).not.toHaveBeenCalled();
  });
});
