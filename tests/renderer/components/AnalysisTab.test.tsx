import { afterEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { AnalysisPrompt } from "@shared/types";

// AnalysisTab reaches the main process through these two api calls only.
vi.mock("@renderer/api", () => ({
  reportProblem: vi.fn(),
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
    expect(getByText(/Analysis prompts could not be loaded\. Reopen this post to try again\./)).toBeTruthy();
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
    expect(result?.getAttribute("role")).toBe("region");
    expect(result?.getAttribute("aria-label")).toBe("Analysis result");
    expect(result?.getAttribute("tabindex")).toBe("0");
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
    expect(getByText("The analysis could not be completed. No result was saved; try again.")).toBeTruthy();
  });

  it("turns Analyze into Stop and disables the prompt picker while a run is in flight", async () => {
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
    expect(button.textContent).toBe("Stop");
    expect(button.disabled).toBe(false);
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

describe("AnalysisTab Stop", () => {
  // A user waiting on a paid stream can cancel it.
  it("Stop aborts the in-flight stream and shows no error", async () => {
    mockListPrompts.mockResolvedValue(PROMPTS);
    let signal: AbortSignal | undefined;
    mockRunStream.mockImplementation(
      (_postId, _prompt, _content, opts) =>
        new Promise<void>((_resolve, reject) => {
          signal = opts.signal;
          opts.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    );
    const { container } = await renderTab();
    const button = container.querySelector(".action-button") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(signal?.aborted).toBe(true);
    expect(button.textContent).toBe("Analyze");
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

it("names the analysis prompt choice", async () => {
  mockListPrompts.mockResolvedValue(PROMPTS);
  const view = await renderTab();
  expect((view.getByRole("combobox", { name: "Prompt" }) as HTMLSelectElement).value).toBe("Summary");
});

function deferredPrompts() {
  let resolve!: (prompts: AnalysisPrompt[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<AnalysisPrompt[]>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const analysisView = (promptsVersion: number, analysisTrigger = 0) => (
  <AnalysisTab postId="p1" content="some body text" analysisTrigger={analysisTrigger} promptsVersion={promptsVersion} />
);

describe("AnalysisTab prompt read lifecycle", () => {
  it("announces a pending initial read and shows empty advice only after successful settlement", async () => {
    const read = deferredPrompts();
    mockListPrompts.mockReturnValue(read.promise);
    const view = render(analysisView(0));
    expect(view.getByRole("status").textContent).toBe("Loading…");
    expect(view.queryByText(/No prompts configured/)).toBeNull();
    await act(async () => { read.resolve([]); });
    expect(view.queryByRole("status")).toBeNull();
    expect(view.getByText(/No prompts configured/)).toBeTruthy();
  });

  it("settles a failed initial read as an error without empty advice", async () => {
    const read = deferredPrompts();
    mockListPrompts.mockReturnValue(read.promise);
    const view = render(analysisView(0));
    await act(async () => { read.reject(new Error("unreadable prompt file")); });
    expect(view.queryByRole("status")).toBeNull();
    expect(view.getByRole("alert").textContent).toContain("Analysis prompts could not be loaded");
    expect(view.queryByText(/No prompts configured/)).toBeNull();
  });

  it("disables old choices and starting analysis while a refresh is pending or failed", async () => {
    mockListPrompts.mockResolvedValueOnce(PROMPTS);
    const view = await renderTab();
    const select = view.getByRole("combobox", { name: "Prompt" }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "Critique" } });
    const read = deferredPrompts();
    mockListPrompts.mockReturnValueOnce(read.promise);
    view.rerender(analysisView(1, 1));
    expect(view.getByRole("status").textContent).toBe("Loading…");
    expect(select.disabled).toBe(true);
    expect((view.getByRole("button", { name: "Analyze" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mockRunStream).not.toHaveBeenCalled();
    await act(async () => { read.reject(new Error("reload failed")); });
    expect(view.queryByRole("status")).toBeNull();
    expect(view.getByRole("alert").textContent).toContain("Analysis prompts could not be loaded");
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("Critique");
    expect((view.getByRole("button", { name: "Analyze" }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(analysisView(1, 2));
    expect(mockRunStream).not.toHaveBeenCalled();

    const retry = deferredPrompts();
    mockListPrompts.mockReturnValueOnce(retry.promise);
    view.rerender(analysisView(2, 2));
    expect(view.queryByRole("alert")).toBeNull();
    await act(async () => { retry.resolve(PROMPTS); });
    expect(select.disabled).toBe(false);
    expect(select.value).toBe("Critique");
    expect((view.getByRole("button", { name: "Analyze" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(["success", "failure"])("ignores stale %s and its settlement while the replacement read is pending", async (outcome) => {
    const obsolete = deferredPrompts();
    const current = deferredPrompts();
    mockListPrompts.mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(current.promise);
    const view = render(analysisView(0));
    view.rerender(analysisView(1));
    await act(async () => {
      if (outcome === "success") obsolete.resolve(PROMPTS);
      else obsolete.reject(new Error("old read failed"));
    });
    expect(view.getByRole("status").textContent).toBe("Loading…");
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.queryByRole("combobox")).toBeNull();
    await act(async () => { current.resolve([{ name: "Latest", text: "latest prompt" }]); });
    expect((view.getByRole("combobox", { name: "Prompt" }) as HTMLSelectElement).value).toBe("Latest");
    expect(view.queryByRole("status")).toBeNull();
  });

  it.each(["success", "failure"])("ignores stale %s after the replacement read has completed", async (outcome) => {
    const obsolete = deferredPrompts();
    mockListPrompts.mockReturnValueOnce(obsolete.promise).mockResolvedValueOnce([{ name: "Latest", text: "new" }]);
    const view = render(analysisView(0));
    await act(async () => { view.rerender(analysisView(1)); });
    await act(async () => {
      if (outcome === "success") obsolete.resolve(PROMPTS);
      else obsolete.reject(new Error("old failure"));
    });
    const select = view.getByRole("combobox", { name: "Prompt" }) as HTMLSelectElement;
    expect(select.value).toBe("Latest");
    expect(select.disabled).toBe(false);
    expect(view.queryByRole("alert")).toBeNull();
  });

  it("keeps Stop available while prompts refresh and after their refresh fails", async () => {
    mockListPrompts.mockResolvedValueOnce(PROMPTS);
    let signal: AbortSignal | undefined;
    mockRunStream.mockImplementation((_post, _prompt, _content, opts) => new Promise((_resolve, reject) => {
      signal = opts.signal;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const view = await renderTab();
    fireEvent.click(view.getByRole("button", { name: "Analyze" }));
    const read = deferredPrompts();
    mockListPrompts.mockReturnValueOnce(read.promise);
    view.rerender(analysisView(1));
    expect((view.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { read.reject(new Error("refresh failed")); });
    expect(view.getByRole("alert").textContent).toContain("Analysis prompts could not be loaded");
    const stop = view.getByRole("button", { name: "Stop" }) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    await act(async () => { fireEvent.click(stop); });
    expect(signal?.aborted).toBe(true);
    expect((view.getByRole("button", { name: "Analyze" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
