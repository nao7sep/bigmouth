import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import type { ImagingOptions } from "@shared/types";

// ImagingTab only calls generateImaging on the backend.
vi.mock("@renderer/api", () => ({
  generateImaging: vi.fn(),
}));

import { ImagingTab } from "@renderer/components/ImagingTab";
import { generateImaging } from "@renderer/api";

const mockGenerate = vi.mocked(generateImaging);

let writeText: ReturnType<typeof vi.fn>;
let originalClipboard: PropertyDescriptor | undefined;

beforeEach(() => {
  // The Copy buttons go through useCopyFeedback → navigator.clipboard.
  writeText = vi.fn().mockResolvedValue(undefined);
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
  mockGenerate.mockReset();
  if (originalClipboard) {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  } else {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
});

function renderTab(props: Partial<{ postId: string; content: string }> = {}) {
  return render(<ImagingTab postId={props.postId ?? "p1"} content={props.content ?? "body text"} />);
}

const DEFAULT_OPTIONS: ImagingOptions = {
  count: 5,
  relation: "domain",
  emotionalLens: "hopeful",
  literalness: "stylized",
  people: "mixed",
  style: "illustration",
};

describe("ImagingTab empty content", () => {
  it("disables Generate and shows the write-content placeholder", () => {
    const { container, getByText } = renderTab({ content: "   " });
    expect((container.querySelector(".action-button") as HTMLButtonElement).disabled).toBe(true);
    expect(getByText("Write some post content first.")).toBeTruthy();
  });

  it("hides the placeholder once content is present", () => {
    const { container } = renderTab();
    expect((container.querySelector(".action-button") as HTMLButtonElement).disabled).toBe(false);
    expect(container.querySelector(".panel-empty")).toBeNull();
  });
});

describe("ImagingTab option controls", () => {
  it("renders all six option fields with their default values", () => {
    const { container } = renderTab();
    const selects = container.querySelectorAll(".imaging-controls select");
    expect(selects).toHaveLength(6);
    const [count, relation, mood, literalness, people, style] = Array.from(
      selects
    ) as HTMLSelectElement[];
    expect(count.value).toBe("5");
    expect(relation.value).toBe("domain");
    expect(mood.value).toBe("hopeful");
    expect(literalness.value).toBe("stylized");
    expect(people.value).toBe("mixed");
    expect(style.value).toBe("illustration");
  });

  it("threads each changed option into generateImaging", async () => {
    mockGenerate.mockResolvedValue([]);
    const { container } = renderTab();
    const selects = Array.from(
      container.querySelectorAll(".imaging-controls select")
    ) as HTMLSelectElement[];
    const [count, relation, mood, literalness, people, style] = selects;

    fireEvent.change(count, { target: { value: "10" } });
    fireEvent.change(relation, { target: { value: "abstract" } });
    fireEvent.change(mood, { target: { value: "intense" } });
    fireEvent.change(literalness, { target: { value: "symbolic" } });
    fireEvent.change(people, { target: { value: "no-people" } });
    fireEvent.change(style, { target: { value: "anime" } });

    await act(async () => {
      fireEvent.click(container.querySelector(".action-button") as HTMLButtonElement);
    });

    expect(mockGenerate).toHaveBeenCalledWith(
      "p1",
      "body text",
      {
        count: 10,
        relation: "abstract",
        emotionalLens: "intense",
        literalness: "symbolic",
        people: "no-people",
        style: "anime",
      },
      expect.any(AbortSignal)
    );
  });
});

describe("ImagingTab run", () => {
  it("renders the generated prompts and the count header", async () => {
    mockGenerate.mockResolvedValue(["a prompt", "another prompt"]);
    const { container, getByText } = renderTab();
    await act(async () => {
      fireEvent.click(container.querySelector(".action-button") as HTMLButtonElement);
    });
    expect(mockGenerate).toHaveBeenCalledWith("p1", "body text", DEFAULT_OPTIONS, expect.any(AbortSignal));
    expect(getByText("2 prompts")).toBeTruthy();
    expect(container.querySelectorAll(".image-prompt-card")).toHaveLength(2);
    expect(getByText("a prompt")).toBeTruthy();
    expect(getByText("another prompt")).toBeTruthy();
  });

  it("shows the loading label and disables controls while generating", async () => {
    let release!: (items: string[]) => void;
    mockGenerate.mockImplementation(
      () => new Promise<string[]>((resolve) => (release = resolve))
    );
    const { container } = renderTab();
    const button = container.querySelector(".action-button") as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.textContent).toBe("Generating…");
    expect(button.disabled).toBe(true);
    const firstSelect = container.querySelector(".imaging-controls select") as HTMLSelectElement;
    expect(firstSelect.disabled).toBe(true);

    await act(async () => {
      release(["done"]);
    });
    expect(button.textContent).toBe("Generate");
    expect(button.disabled).toBe(false);
  });

  it("surfaces a generation error in the error panel", async () => {
    mockGenerate.mockRejectedValue(new Error("imaging boom"));
    const { container, getByText } = renderTab();
    await act(async () => {
      fireEvent.click(container.querySelector(".action-button") as HTMLButtonElement);
    });
    expect(container.querySelector(".panel-error")).toBeTruthy();
    expect(getByText("imaging boom")).toBeTruthy();
  });

  it("ignores a stale run's result after the post switches", async () => {
    // The first run's promise rejects via abort once the post changes; because
    // controller.signal.aborted is true, the component swallows it.
    mockGenerate.mockImplementation(
      (_postId, _content, _options, signal) =>
        new Promise<string[]>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        })
    );
    const { container, rerender } = renderTab();
    await act(async () => {
      fireEvent.click(container.querySelector(".action-button") as HTMLButtonElement);
    });

    await act(async () => {
      rerender(<ImagingTab postId="p2" content="body text" />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    // No error panel and no stale items rendered from the aborted run.
    expect(container.querySelector(".panel-error")).toBeNull();
    expect(container.querySelector(".image-prompt-card")).toBeNull();
  });
});

describe("ImagingTab copy", () => {
  it("copies a single prompt and flips the button label", async () => {
    mockGenerate.mockResolvedValue(["one", "two"]);
    const { container, getAllByTitle } = renderTab();
    await act(async () => {
      fireEvent.click(container.querySelector(".action-button") as HTMLButtonElement);
    });

    const copyButtons = getAllByTitle("Copy prompt");
    await act(async () => {
      fireEvent.click(copyButtons[0]);
    });
    expect(writeText).toHaveBeenCalledWith("one");
    expect(copyButtons[0].textContent).toBe("✓ Copied");
  });

  it("copies all prompts joined by blank lines", async () => {
    mockGenerate.mockResolvedValue(["one", "two"]);
    const { container, getByTitle } = renderTab();
    await act(async () => {
      fireEvent.click(container.querySelector(".action-button") as HTMLButtonElement);
    });

    const copyAll = getByTitle("Copy all prompts");
    await act(async () => {
      fireEvent.click(copyAll);
    });
    expect(writeText).toHaveBeenCalledWith("one\n\ntwo");
    expect(copyAll.textContent).toBe("✓ Copied");
  });
});
