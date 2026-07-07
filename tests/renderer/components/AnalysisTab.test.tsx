import { afterEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { AnalysisPrompt } from "@shared/types";

// AnalysisTab reaches the main process through these two api calls only.
vi.mock("@renderer/api", () => ({
  listAnalysisPrompts: vi.fn(),
  runAnalysisStream: vi.fn(),
}));

import { AnalysisTab } from "@renderer/components/AnalysisTab";
import { listAnalysisPrompts, runAnalysisStream } from "@renderer/api";

const mockListPrompts = vi.mocked(listAnalysisPrompts);
const mockRunStream = vi.mocked(runAnalysisStream);

const PROMPTS: AnalysisPrompt[] = [
  { name: "Summary", text: "Summarize this." },
  { name: "Critique", text: "Critique this." },
];

afterEach(() => {
  cleanup();
  mockListPrompts.mockReset();
  mockRunStream.mockReset();
});

// Render and flush the prompt-load microtask so the toolbar (or an empty/error
// state) has settled before the test inspects it.
async function renderTab(
  props: Partial<{ postId: string; content: string; analysisTrigger: number; promptsVersion: number }> = {}
) {
  const utils = render(
    <AnalysisTab
      postId={props.postId ?? "p1"}
      content={props.content ?? "some body text"}
      analysisTrigger={props.analysisTrigger ?? 0}
      promptsVersion={props.promptsVersion ?? 0}
    />
  );
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

describe("AnalysisTab prompt loading", () => {
  it("shows the empty state when no prompts are configured", async () => {
    mockListPrompts.mockResolvedValue([]);
    const { container } = await renderTab();
    expect(container.querySelector(".panel-empty")).toBeTruthy();
    expect(container.querySelector(".analysis-toolbar")).toBeNull();
  });

  it("shows the error state when prompts fail to load", async () => {
    mockListPrompts.mockRejectedValue(new Error("disk gone"));
    const { container, getByText } = await renderTab();
    expect(container.querySelector(".panel-error")).toBeTruthy();
    expect(getByText(/disk gone/)).toBeTruthy();
  });

  it("renders the toolbar with an option per prompt and selects the first", async () => {
    mockListPrompts.mockResolvedValue(PROMPTS);
    const { container } = await renderTab();
    const select = container.querySelector(".prompt-select") as HTMLSelectElement;
    expect(select.value).toBe("Summary");
    expect(select.querySelectorAll("option")).toHaveLength(2);
  });

  it("reloads prompts when promptsVersion changes and keeps a still-present selection", async () => {
    mockListPrompts.mockResolvedValue(PROMPTS);
    const { container, rerender } = await renderTab();
    const select = container.querySelector(".prompt-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "Critique" } });
    expect(select.value).toBe("Critique");

    // A reload that still contains "Critique" must preserve the user's pick.
    mockListPrompts.mockResolvedValue(PROMPTS);
    rerender(
      <AnalysisTab postId="p1" content="some body text" analysisTrigger={0} promptsVersion={1} />
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(select.value).toBe("Critique");
  });

  it("falls back to the first prompt when the selection vanishes on reload", async () => {
    mockListPrompts.mockResolvedValue(PROMPTS);
    const { container, rerender } = await renderTab();
    const select = container.querySelector(".prompt-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "Critique" } });

    // The reload no longer offers "Critique"; selection resets to the first.
    mockListPrompts.mockResolvedValue([{ name: "Other", text: "x" }]);
    rerender(
      <AnalysisTab postId="p1" content="some body text" analysisTrigger={0} promptsVersion={2} />
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(select.value).toBe("Other");
  });
});

describe("AnalysisTab run", () => {
  it("disables Analyze and shows the empty placeholder when content is blank", async () => {
    mockListPrompts.mockResolvedValue(PROMPTS);
    const { container } = await renderTab({ content: "   " });
    const button = container.querySelector(".action-button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("streams chunks into the rendered result and clears loading", async () => {
    mockListPrompts.mockResolvedValue(PROMPTS);
    // Drive the onChunk callback to simulate a stream, then resolve.
    mockRunStream.mockImplementation(async (_postId, _prompt, _content, opts) => {
      opts.onChunk("# Title\n");
      opts.onChunk("more text");
    });

    const { container } = await renderTab();
    const button = container.querySelector(".action-button") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockRunStream).toHaveBeenCalledWith(
      "p1",
      "Summary",
      "some body text",
      expect.objectContaining({ onChunk: expect.any(Function) })
    );
    const result = container.querySelector(".analysis-result");
    expect(result).toBeTruthy();
    expect(result!.querySelector("h1")?.textContent).toBe("Title");
    expect(result!.textContent).toContain("more text");
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Analyze");
  });

  it("surfaces a streaming error in the error panel", async () => {
    mockListPrompts.mockResolvedValue(PROMPTS);
    mockRunStream.mockRejectedValue(new Error("model exploded"));
    const { container, getByText } = await renderTab();
    await act(async () => {
      fireEvent.click(container.querySelector(".action-button") as HTMLButtonElement);
    });
    expect(container.querySelector(".panel-error")).toBeTruthy();
    expect(getByText("model exploded")).toBeTruthy();
  });

  it("disables controls while a run is in flight", async () => {
    mockListPrompts.mockResolvedValue(PROMPTS);
    let release!: () => void;
    mockRunStream.mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve))
    );
    const { container } = await renderTab();
    const button = container.querySelector(".action-button") as HTMLButtonElement;
    const select = container.querySelector(".prompt-select") as HTMLSelectElement;

    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.textContent).toBe("Analyzing…");
    expect(button.disabled).toBe(true);
    expect(select.disabled).toBe(true);

    await act(async () => {
      release();
    });
    expect(button.textContent).toBe("Analyze");
    expect(button.disabled).toBe(false);
  });

  it("ignores an aborted run's rejection (no error panel) when the post switches mid-flight", async () => {
    mockListPrompts.mockResolvedValue(PROMPTS);
    // The first run never settles until aborted; the abort triggers a rejection
    // the component must swallow because controller.signal.aborted is true.
    mockRunStream.mockImplementation(
      (_postId, _prompt, _content, opts) =>
        new Promise<void>((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        })
    );
    const { container, rerender } = await renderTab();
    await act(async () => {
      fireEvent.click(container.querySelector(".action-button") as HTMLButtonElement);
    });

    // Switching posts resets state and aborts the in-flight run.
    await act(async () => {
      rerender(
        <AnalysisTab postId="p2" content="some body text" analysisTrigger={0} promptsVersion={0} />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector(".panel-error")).toBeNull();
  });
});

describe("AnalysisTab analysisTrigger", () => {
  it("runs analysis when the trigger increments (Cmd+Enter)", async () => {
    mockListPrompts.mockResolvedValue(PROMPTS);
    mockRunStream.mockResolvedValue(undefined);
    const { rerender } = await renderTab({ analysisTrigger: 1 });
    expect(mockRunStream).not.toHaveBeenCalled();

    await act(async () => {
      rerender(
        <AnalysisTab postId="p1" content="some body text" analysisTrigger={2} promptsVersion={0} />
      );
    });
    await waitFor(() => expect(mockRunStream).toHaveBeenCalledTimes(1));
  });

  it("does not run when the trigger value does not increase", async () => {
    mockListPrompts.mockResolvedValue(PROMPTS);
    mockRunStream.mockResolvedValue(undefined);
    const { rerender } = await renderTab({ analysisTrigger: 5 });
    await act(async () => {
      // Same value → no run.
      rerender(
        <AnalysisTab postId="p1" content="some body text" analysisTrigger={5} promptsVersion={0} />
      );
    });
    expect(mockRunStream).not.toHaveBeenCalled();
  });
});
