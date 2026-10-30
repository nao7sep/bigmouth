// The Records window over 10,000 records in the real records database while
// more arrive (logging-conventions, The Records window): pages of 100 newest
// first, every record paged once in order as the list is walked down a screen
// at a time, new records at the top on their own while the list is there, and
// nothing moving while it is scrolled down, including a newest page that was
// already being read when the reader scrolled away.
//
// jsdom lays nothing out, so the list's scroll box reports a height made from
// the rows it renders, a fixed height each; the window itself reads only the
// scroll offset, visible height and content height, as in the app.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RECORDS_LIST_WIDTH } from "@shared/layout";
import type { RecordsHealth, RecordsPage, RecordsQuery } from "@shared/records";

const api = vi.hoisted(() => ({
  recordsChanged: null as (() => void) | null,
  // Set by a test to hold the next newest-page read until it says so.
  holdNewest: null as Promise<void> | null,
}));

vi.mock("@renderer/api", async () => {
  const store = await import("@main/core/services/recordsStore.js");
  return {
    readRecordsPage: async (query: RecordsQuery): Promise<RecordsPage> => {
      const page = store.readRecordsPage(query);
      if (query.after === null && api.holdNewest !== null) {
        const hold = api.holdNewest;
        api.holdNewest = null;
        await hold;
      }
      return page;
    },
    readRecordDetail: async (kind: "log" | "provider-call", id: number) => store.readRecordDetail(kind, id),
    readRecordSources: async () => ({ currentSession: store.currentRecordsSession(), sessions: store.readRecordSessions(), workspaces: [] }),
    getRecordsHealth: async (): Promise<RecordsHealth> => store.recordsHealth(),
    onRecordsHealthChanged: () => () => {},
    updateUiState: async () => ({}),
    reportProblem: (what: string, err: unknown) => { throw new Error(`${what}: ${String(err)}`); },
    onRecordsChanged: (listener: () => void) => {
      api.recordsChanged = listener;
      return () => { api.recordsChanged = null; };
    },
  };
});

import { closeRecords, onRecordStored, openRecords, writeLogRecord } from "@main/core/services/recordsStore.js";
import { RecordsWindow } from "@renderer/records/RecordsWindow";

const SEEDED = 10_000;
const PAGE = 100;
const ROW = 24;
const VISIBLE = 480;
const START = Date.parse("2026-10-30T00:00:00.000Z");

let root: string;
let logged = 0;
let scrollTop = 0;

const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
const titles = () => options().map((option) => option.querySelector(".records-row-title")?.textContent);
const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]')!;
// Every child of the list, its rows and any note after them, is one row high.
const contentHeight = () => listbox().childElementCount * ROW;

function log(title: string): void {
  logged++;
  const time = new Date(START + logged).toISOString();
  writeLogRecord({ time, level: "info", message: title, workspaceId: null, postId: null, event: "{}" });
}

/** Every title in the database, newest first. */
const databaseOrder = (): string[] => [
  ...Array.from({ length: logged - SEEDED }, (_, i) => `live record ${logged - SEEDED - i}`),
  ...Array.from({ length: SEEDED }, (_, i) => `seed record ${SEEDED - i}`),
];

async function scrollTo(top: number): Promise<void> {
  await act(async () => {
    scrollTop = top;
    listbox().dispatchEvent(new Event("scroll"));
  });
}

/** Lets the window's one-second live read run, and the reads it starts settle. */
async function liveTick(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-records-live-"));
  openRecords(path.join(root, "records.sqlite3"), path.join(root, "logs"), new Date(START));
  logged = 0;
  for (let n = 0; n < SEEDED; n++) log(`seed record ${n + 1}`);
  onRecordStored(() => api.recordsChanged?.());
  scrollTop = 0;
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
  const isScroll = (element: HTMLElement) => element.classList.contains("records-list");
  Object.defineProperties(HTMLElement.prototype, {
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) { return isScroll(this) ? scrollTop : 0; },
      set(this: HTMLElement, value: number) { if (isScroll(this)) scrollTop = value; },
    },
    scrollHeight: { configurable: true, get(this: HTMLElement) { return isScroll(this) ? contentHeight() : 0; } },
    clientHeight: { configurable: true, get(this: HTMLElement) { return isScroll(this) ? VISIBLE : 0; } },
    clientWidth: { configurable: true, get(this: HTMLElement) { return this.classList.contains("records-shell") ? 2000 : 0; } },
    scrollIntoView: { configurable: true, value: () => {} },
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const name of ["scrollTop", "scrollHeight", "clientHeight", "clientWidth", "scrollIntoView"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
  onRecordStored(null);
  closeRecords();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the Records window over 10,000 records arriving live", () => {
  it("pages, shows arrivals at the top, and holds still while scrolled down", async () => {
    await act(async () => {
      render(<RecordsWindow initialListWidth={RECORDS_LIST_WIDTH.default} />);
    });

    // The first page: 100 records, newest first. It fills the window, so no
    // second page is read yet.
    expect(titles()).toEqual(databaseOrder().slice(0, PAGE));

    // At the top, records logged now appear at the top on their own.
    log("live record 1");
    log("live record 2");
    await liveTick();
    expect(titles().slice(0, 3)).toEqual(["live record 2", "live record 1", `seed record ${SEEDED}`]);

    // Scrolled down with a record selected, new records move nothing: not the
    // offset, the first row, the rows loaded or the selection and its detail.
    await scrollTo(10 * ROW);
    const chosen = options()[12]!;
    await act(async () => { fireEvent.click(chosen); });
    const selectedTitle = chosen.querySelector(".records-row-title")?.textContent;
    const detail = () => document.querySelector(".records-detail-pane")?.textContent;
    const before = { scrollTop, titles: titles(), detail: detail() };
    expect(before.detail).toContain(selectedTitle);
    for (let n = 3; n <= 7; n++) {
      log(`live record ${n}`);
      await liveTick();
    }
    expect({ scrollTop, titles: titles(), detail: detail() }).toEqual(before);

    // Back at the top, the records that waited are there.
    await scrollTo(0);
    expect(titles().slice(0, 8)).toEqual([...Array.from({ length: 7 }, (_, i) => `live record ${7 - i}`), `seed record ${SEEDED}`]);

    // A newest page already being read when the reader scrolls away is not
    // applied: it waits until the list is back at the top.
    const atTop = titles();
    let release!: () => void;
    api.holdNewest = new Promise((resolve) => { release = resolve; });
    log("live record 8");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await scrollTo(10 * ROW);
    await act(async () => { release(); });
    expect(titles()).toEqual(atTop);

    // Back at the top, it is there, and the selection and its detail stayed.
    await scrollTo(0);
    expect(titles().slice(0, 9)).toEqual([...Array.from({ length: 8 }, (_, i) => `live record ${8 - i}`), `seed record ${SEEDED}`]);
    const selected = options().find((option) => option.getAttribute("aria-selected") === "true");
    expect(selected?.querySelector(".records-row-title")?.textContent).toBe(selectedTitle);
    expect(detail()).toBe(before.detail);

    // Walking down a screen at a time loads every record once, in order, while
    // records keep arriving; the next page is read only once the distance left
    // below the visible part is no more than the visible height.
    let arrived = 8;
    let steps = 0;
    while (scrollTop + VISIBLE < contentHeight()) {
      const remaining = contentHeight() - (scrollTop + VISIBLE + VISIBLE);
      const loadedBefore = listbox().childElementCount;
      await scrollTo(scrollTop + VISIBLE);
      const loadedAfter = listbox().childElementCount;
      if (remaining > VISIBLE) expect(loadedAfter).toBe(loadedBefore);
      if (++steps % 50 === 0) {
        log(`live record ${++arrived}`);
        await liveTick();
      }
    }
    const shown = titles();
    expect(shown).toHaveLength(SEEDED + 8);
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown).toEqual(databaseOrder().slice(arrived - 8));

    // Back at the top, the records that arrived during the walk join it.
    await scrollTo(0);
    expect(titles()).toEqual(databaseOrder());
  });
});
