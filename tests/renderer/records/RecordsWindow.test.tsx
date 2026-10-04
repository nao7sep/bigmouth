import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { DIVIDER, RECORDS_DETAIL_MIN_WIDTH, RECORDS_LIST_WIDTH } from "@shared/layout";
import type { RecordDetail, RecordSources, RecordsPage, RecordsQuery, RecordSummary } from "@shared/records";

const api = vi.hoisted(() => ({
  readRecordsPage: vi.fn<(query: RecordsQuery) => Promise<RecordsPage>>(),
  readRecordDetail: vi.fn<(kind: string, id: number) => Promise<RecordDetail | null>>(),
  readRecordSources: vi.fn<() => Promise<RecordSources>>(),
  updateUiState: vi.fn<(patch: Record<string, unknown>) => Promise<unknown>>(),
  reportProblem: vi.fn(),
  recordsChanged: null as (() => void) | null,
}));

vi.mock("@renderer/api", () => ({
  readRecordsPage: api.readRecordsPage,
  readRecordDetail: api.readRecordDetail,
  readRecordSources: api.readRecordSources,
  updateUiState: api.updateUiState,
  reportProblem: api.reportProblem,
  onRecordsChanged: (listener: () => void) => {
    api.recordsChanged = listener;
    return () => {
      api.recordsChanged = null;
    };
  },
}));

import { RecordsWindow } from "@renderer/records/RecordsWindow";

const SESSION = "2026-10-02T08:00:00.000Z";

const call: RecordSummary = {
  kind: "provider-call", id: 4, session: SESSION, time: "2026-10-02T08:01:00.000Z", level: "error",
  title: "anthropic metadata", text: "claude-x",
};
const line: RecordSummary = {
  kind: "log", id: 9, session: SESSION, time: "2026-10-02T08:00:30.000Z", level: "warn",
  title: "post save failed", text: null,
};
const newer: RecordSummary = {
  kind: "log", id: 12, session: SESSION, time: "2026-10-02T08:02:00.000Z", level: "info",
  title: "arrived while open", text: null,
};
const callDetail: RecordDetail = {
  kind: "provider-call", id: 4, session: SESSION, workspaceId: "ws-1", postId: "post-1", purpose: "metadata",
  provider: "anthropic", startedAt: "2026-10-02T08:01:00.000Z", finishedAt: "2026-10-02T08:01:02.500Z",
  request: JSON.stringify({ headers: { "x-api-key": "sk-test" }, body: { model: "claude-x" } }),
  response: "null",
  error: JSON.stringify({ name: "Error", message: "quota" }),
};
const lineDetail: RecordDetail = {
  kind: "log", id: 9, session: SESSION, time: "2026-10-02T08:00:30.000Z", level: "warn",
  message: "post save failed", workspaceId: null, postId: "post-1",
  event: JSON.stringify({ level: "warn", message: "post save failed", postId: "post-1" }),
};

// jsdom lays nothing out, so the list's scroll box and the shell's width are
// set here. By default the list is scrolled to the top and far from its end.
const box = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, shellWidth: 2000 };
const resizeCallbacks = new Set<() => void>();
class TestResizeObserver {
  private readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
  }
  observe(): void {
    resizeCallbacks.add(this.callback);
  }
  disconnect(): void {
    resizeCallbacks.delete(this.callback);
  }
}
const isScroll = (element: HTMLElement) => element.classList.contains("records-list");

beforeEach(() => {
  api.readRecordsPage.mockReset().mockResolvedValue({ records: [call, line], more: false });
  api.readRecordDetail.mockReset().mockImplementation(async (kind) => (kind === "log" ? lineDetail : callDetail));
  api.readRecordSources.mockReset().mockResolvedValue({
    currentSession: SESSION,
    sessions: [SESSION, "2026-10-01T08:00:00.000Z"],
    workspaces: [{ id: "ws-1", name: "Blog" }],
  });
  api.updateUiState.mockReset().mockResolvedValue({});
  api.reportProblem.mockReset();
  api.recordsChanged = null;
  Object.assign(box, { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, shellWidth: 2000 });
  resizeCallbacks.clear();
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  Object.defineProperties(HTMLElement.prototype, {
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) { return isScroll(this) ? box.scrollTop : 0; },
      set(this: HTMLElement, value: number) { if (isScroll(this)) box.scrollTop = value; },
    },
    scrollHeight: { configurable: true, get(this: HTMLElement) { return isScroll(this) ? box.scrollHeight : 0; } },
    clientHeight: { configurable: true, get(this: HTMLElement) { return isScroll(this) ? box.clientHeight : 0; } },
    clientWidth: {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains("records-shell") ? box.shellWidth : 0; },
    },
    scrollIntoView: { configurable: true, value: () => {} },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const name of ["scrollTop", "scrollHeight", "clientHeight", "clientWidth", "scrollIntoView"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

async function mount(): Promise<ReturnType<typeof render>> {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<RecordsWindow initialListWidth={RECORDS_LIST_WIDTH.default} />);
  });
  return view;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
const titles = () => options().map((option) => option.querySelector(".records-row-title")?.textContent);
const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]')!;
const lastQuery = (): RecordsQuery => api.readRecordsPage.mock.calls.at(-1)![0];
const selects = () => Array.from(document.querySelectorAll("select"));
const scrollTo = async (top: number, events = 1) => {
  await act(async () => {
    box.scrollTop = top;
    for (let index = 0; index < events; index++) listbox().dispatchEvent(new Event("scroll"));
  });
};
const press = async (key: string) => {
  await act(async () => {
    fireEvent.keyDown(listbox(), { key });
  });
};
const click = async (element: HTMLElement) => {
  await act(async () => {
    fireEvent.click(element);
  });
};
const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    fireEvent.change(select, { target: { value } });
  });
};
const signal = async () => {
  await act(async () => api.recordsChanged!());
};
const cursorOf = (record: RecordSummary) => ({ time: record.time, kind: record.kind, id: record.id });

describe("RecordsWindow", () => {
  it("lists the records newest first, with every filter off and nothing selected yet", async () => {
    await mount();

    expect(titles()).toEqual(["anthropic metadata", "post save failed"]);
    expect(lastQuery()).toEqual({ session: null, kind: null, level: null, search: "", after: null });
    expect(document.body.textContent).toContain("Select a record to see everything it holds.");
    expect(options().map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "false"]);
    // One tab stop: the listbox holds focus, and its rows are not focusable.
    expect(listbox().tabIndex).toBe(0);
    expect(options().every((option) => !option.hasAttribute("tabindex"))).toBe(true);
  });

  it("shows everything a selected provider call holds", async () => {
    await mount();
    await click(options()[0]!);

    expect(api.readRecordDetail).toHaveBeenCalledWith("provider-call", 4);
    const blocks = Array.from(document.querySelectorAll(".records-block")).map((block) => [
      block.querySelector("h3")?.textContent,
      block.querySelector("pre")?.textContent,
    ]);
    // The stored response is null, so it has no block.
    expect(blocks).toEqual([
      ["Request", JSON.stringify(JSON.parse(callDetail.request), null, 2)],
      ["Error", JSON.stringify({ name: "Error", message: "quota" }, null, 2)],
    ]);
    const body = document.querySelector(".records-detail-body")!.textContent!;
    expect(body).toContain("Blog");
    expect(body).toContain("ws-1");
    expect(body).toContain("post-1");
    // The purpose is named as its tab is.
    expect(body).toContain("Metadata");
    expect(body).toContain("2.500");
    expect(body).toContain("(this launch)");
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("leaves out every block of a provider call that holds nothing", async () => {
    api.readRecordDetail.mockResolvedValue({ ...callDetail, request: "{}", response: "[]", error: "  " });
    await mount();
    await click(options()[0]!);

    expect(document.querySelector(".records-detail-title")?.textContent).toBe("anthropic metadata");
    expect(document.querySelectorAll(".records-block")).toHaveLength(0);
  });

  it("shows no Event block for a log line whose fields the pane already shows", async () => {
    await mount();
    await click(options()[1]!);

    expect(api.readRecordDetail).toHaveBeenCalledWith("log", 9);
    expect(document.querySelector(".records-detail-title")?.textContent).toBe("post save failed");
    expect(document.querySelectorAll(".records-block")).toHaveLength(0);
  });

  it("shows only the fields of a log line the pane does not already show", async () => {
    const event = JSON.stringify({
      time: lineDetail.time, level: "warn", message: "post save failed", postId: "post-1", reason: "disk full",
    });
    api.readRecordDetail.mockResolvedValue({ ...lineDetail, event });
    await mount();
    await click(options()[1]!);

    const blocks = Array.from(document.querySelectorAll(".records-block"));
    expect(blocks.map((block) => block.querySelector("h3")?.textContent)).toEqual(["Event"]);
    expect(blocks[0]!.querySelector("pre")?.textContent).toBe(JSON.stringify({ reason: "disk full" }, null, 2));
  });

  it("moves the selection with the arrow keys, the cursor drawn on the row", async () => {
    await mount();
    await click(options()[0]!);
    await press("ArrowDown");

    expect(listbox().getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
    expect(options()[1]!.classList.contains("active")).toBe(true);
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(api.readRecordDetail).toHaveBeenLastCalledWith("log", 9);
  });

  it("reads again with each filter, and searches once typing pauses", async () => {
    await mount();
    const [kind, level, launch] = selects();
    expect(Array.from(launch!.options).map((option) => option.textContent)).toEqual([
      "All launches",
      expect.stringContaining("(this launch)"),
      expect.not.stringContaining("(this launch)"),
    ]);

    await choose(launch!, SESSION);
    await choose(kind!, "provider-call");
    await choose(level!, "error");
    expect(lastQuery()).toEqual({ session: SESSION, kind: "provider-call", level: "error", search: "", after: null });

    vi.useFakeTimers();
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      fireEvent.change(search, { target: { value: "quota" } });
    });
    expect(lastQuery().search).toBe("");
    await act(async () => vi.advanceTimersByTime(300));
    expect(lastQuery().search).toBe("quota");
  });

  it("offers Needs attention first among the levels, and both kinds", async () => {
    await mount();
    const [kind, level] = selects();
    expect(Array.from(level!.options).map((option) => option.textContent)).toEqual([
      "All levels", "Needs attention", "Error", "Warning", "Info", "Debug",
    ]);
    expect(Array.from(kind!.options).map((option) => option.textContent)).toEqual([
      "All kinds", "Log line", "Provider call",
    ]);
    expect(level!.value).toBe("");
  });

  it("shows a loading note while the first page is read, then the rows", async () => {
    const first = deferred<RecordsPage>();
    api.readRecordsPage.mockReturnValueOnce(first.promise);
    await mount();

    expect(document.body.textContent).toContain("Loading records…");
    expect(document.body.textContent).not.toContain("No records match these filters.");
    expect(options()).toHaveLength(0);
    // The listbox stays mounted and reachable while it has no rows.
    expect(listbox().tabIndex).toBe(0);

    await act(async () => first.resolve({ records: [call, line], more: false }));
    expect(options()).toHaveLength(2);
    expect(document.body.textContent).not.toContain("Loading records…");
  });

  it("says so inside the list when no record matches", async () => {
    api.readRecordsPage.mockResolvedValue({ records: [], more: false });
    await mount();
    expect(listbox().textContent).toContain("No records match these filters.");
  });

  it("has no buttons at all: paging and updates need none", async () => {
    await mount();
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });

  it("reads the next page from the last row once the list is scrolled near its end", async () => {
    api.readRecordsPage.mockResolvedValueOnce({ records: [call], more: true });
    api.readRecordsPage.mockResolvedValueOnce({ records: [line], more: false });
    await mount();
    expect(api.readRecordsPage).toHaveBeenCalledOnce();

    await scrollTo(700);

    expect(api.readRecordsPage).toHaveBeenCalledTimes(2);
    expect(lastQuery().after).toEqual(cursorOf(call));
    expect(titles()).toEqual(["anthropic metadata", "post save failed"]);
  });

  it("reads the next page when ArrowDown is pressed on the last row", async () => {
    api.readRecordsPage.mockResolvedValueOnce({ records: [call, line], more: true });
    api.readRecordsPage.mockResolvedValueOnce({ records: [], more: false });
    await mount();
    await click(options()[1]!);
    await press("ArrowDown");

    expect(api.readRecordsPage).toHaveBeenCalledTimes(2);
    expect(lastQuery().after).toEqual(cursorOf(line));
    expect(listbox().getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
  });

  it("makes one request for two scroll events together", async () => {
    api.readRecordsPage.mockResolvedValueOnce({ records: [call, line], more: true });
    api.readRecordsPage.mockReturnValueOnce(new Promise<RecordsPage>(() => {}));
    await mount();

    await scrollTo(800, 2);

    expect(api.readRecordsPage).toHaveBeenCalledTimes(2);
    expect(options()).toHaveLength(2);
    expect(document.body.textContent).toContain("Loading records…");
  });

  it("reads the next page by itself while a page does not fill the list", async () => {
    box.scrollHeight = 150;
    api.readRecordsPage.mockResolvedValueOnce({ records: [call], more: true });
    api.readRecordsPage.mockResolvedValueOnce({ records: [line], more: false });
    await mount();

    expect(api.readRecordsPage).toHaveBeenCalledTimes(2);
    expect(titles()).toEqual(["anthropic metadata", "post save failed"]);
  });

  it("keeps a failed page's note at the end, and reads it again when the end is reached again", async () => {
    api.readRecordsPage.mockResolvedValueOnce({ records: [call], more: true });
    api.readRecordsPage.mockRejectedValueOnce(new Error("busy"));
    api.readRecordsPage.mockResolvedValueOnce({ records: [line], more: false });
    await mount();

    await scrollTo(700);
    expect(document.body.textContent).toContain("The records could not be read.");
    expect(options()).toHaveLength(1);
    expect(api.readRecordsPage).toHaveBeenCalledTimes(2);

    await scrollTo(750);
    expect(api.readRecordsPage).toHaveBeenCalledTimes(3);
    expect(lastQuery().after).toEqual(cursorOf(call));
    expect(titles()).toEqual(["anthropic metadata", "post save failed"]);
    expect(document.body.textContent).not.toContain("The records could not be read.");
  });

  it("re-reads the newest page once for a burst of new records while at the top, keeping the rows shown", async () => {
    await mount();
    vi.useFakeTimers();
    const next = deferred<RecordsPage>();
    api.readRecordsPage.mockReturnValueOnce(next.promise);

    await signal();
    await signal();
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));

    expect(api.readRecordsPage).toHaveBeenCalledTimes(2);
    expect(lastQuery()).toEqual({ session: null, kind: null, level: null, search: "", after: null });
    expect(api.readRecordSources).toHaveBeenCalledTimes(2);
    expect(options()).toHaveLength(2);
    expect(document.body.textContent).not.toContain("Loading records…");

    await act(async () => next.resolve({ records: [newer, call, line], more: false }));
    expect(titles()).toEqual(["arrived while open", "anthropic metadata", "post save failed"]);
  });

  it("leaves the list alone while scrolled down, and shows new records once back at the top", async () => {
    await mount();
    await scrollTo(300);
    vi.useFakeTimers();
    api.readRecordsPage.mockResolvedValueOnce({ records: [newer, call, line], more: false });

    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(api.readRecordsPage).toHaveBeenCalledOnce();
    expect(options()).toHaveLength(2);

    await scrollTo(0);
    expect(api.readRecordsPage).toHaveBeenCalledTimes(2);
    expect(titles()).toEqual(["arrived while open", "anthropic metadata", "post save failed"]);
  });

  it("keeps the selected record selected through an update", async () => {
    await mount();
    await click(options()[1]!);
    vi.useFakeTimers();
    api.readRecordsPage.mockResolvedValueOnce({ records: [newer, call, line], more: false });

    await signal();
    await act(async () => vi.advanceTimersByTime(1000));

    expect(options()).toHaveLength(3);
    expect(options()[2]!.getAttribute("aria-selected")).toBe("true");
    expect(api.readRecordDetail).toHaveBeenCalledOnce();
  });

  it("stops reading on new-record signals after a failed read, so a logged failure cannot start the next read", async () => {
    await mount();
    vi.useFakeTimers();
    api.readRecordsPage.mockRejectedValueOnce(new Error("busy"));

    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(api.readRecordsPage).toHaveBeenCalledTimes(2);

    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(api.readRecordsPage).toHaveBeenCalledTimes(2);
    expect(options()).toHaveLength(2);
  });

  it("listens to new records again once a read succeeds", async () => {
    await mount();
    vi.useFakeTimers();
    api.readRecordsPage.mockRejectedValueOnce(new Error("busy"));
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));

    // A filter change reads afresh; once that read succeeds, signals count again.
    await choose(selects()[0]!, "log");
    expect(api.readRecordsPage).toHaveBeenCalledTimes(3);
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(api.readRecordsPage).toHaveBeenCalledTimes(4);
  });

  it("stops listening for new records when it closes", async () => {
    const view = await mount();
    expect(api.recordsChanged).not.toBeNull();
    view.unmount();
    expect(api.recordsChanged).toBeNull();
  });

  it("saves the list width once when a drag ends, clamped to the pane's bounds", async () => {
    await mount();
    const divider = document.querySelector<HTMLElement>(".pane-divider")!;

    await act(async () => {
      fireEvent.mouseDown(divider, { clientX: 0 });
      fireEvent.mouseMove(document, { clientX: 100 });
      fireEvent.mouseMove(document, { clientX: 2000 });
      fireEvent.mouseUp(document);
    });

    expect(api.updateUiState).toHaveBeenCalledExactlyOnceWith({ recordsListWidth: RECORDS_LIST_WIDTH.max });
    const shell = document.querySelector<HTMLElement>(".records-shell")!;
    expect(shell.style.getPropertyValue("--records-list-width")).toBe(`${RECORDS_LIST_WIDTH.max}px`);
  });

  it("saves nothing for a press on the divider that drags nowhere", async () => {
    await mount();
    await act(async () => {
      fireEvent.mouseDown(document.querySelector<HTMLElement>(".pane-divider")!, { clientX: 0 });
      fireEvent.mouseUp(document);
    });
    expect(api.updateUiState).not.toHaveBeenCalled();
  });

  it("narrows the list when the window narrows, saving nothing", async () => {
    await mount();
    const shell = document.querySelector<HTMLElement>(".records-shell")!;
    expect(shell.style.getPropertyValue("--records-list-width")).toBe(`${RECORDS_LIST_WIDTH.default}px`);

    await act(async () => {
      box.shellWidth = DIVIDER + RECORDS_DETAIL_MIN_WIDTH + RECORDS_LIST_WIDTH.min;
      for (const callback of resizeCallbacks) callback();
    });

    expect(shell.style.getPropertyValue("--records-list-width")).toBe(`${RECORDS_LIST_WIDTH.min}px`);
    expect(api.updateUiState).not.toHaveBeenCalled();
  });

  it("says when the records cannot be read, without the raw error", async () => {
    api.readRecordsPage.mockRejectedValue(new Error("SQLITE_CORRUPT /Users/someone/.bigmouth/records.sqlite3"));
    await mount();

    expect(document.body.textContent).toContain("The records could not be read.");
    expect(document.body.textContent).not.toContain("SQLITE_CORRUPT");
    expect(api.reportProblem).toHaveBeenCalled();
  });

  it("says when a record cannot be read", async () => {
    api.readRecordDetail.mockRejectedValue(new Error("gone"));
    await mount();
    await click(options()[0]!);
    expect(document.body.textContent).toContain("This record could not be read.");
  });
});
