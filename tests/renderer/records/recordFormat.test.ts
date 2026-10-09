import { describe, expect, it } from "vitest";

import {
  blockText,
  cursorAfter,
  durationSeconds,
  logEventText,
  mergeNewestPage,
  purposeLabel,
  recordKey,
} from "@renderer/records/recordFormat";
import type { LogRecordDetail, RecordSummary } from "@shared/records";

const row = (id: number, time: string, title = `row ${id}`): RecordSummary => ({
  kind: "log", id, session: "s", time, level: "info", title, text: null, stopped: false,
});

const a = row(1, "2026-10-02T08:00:01.000Z");
const b = row(2, "2026-10-02T08:00:02.000Z");
const c = row(3, "2026-10-02T08:00:03.000Z");
const d = row(4, "2026-10-02T08:00:04.000Z");
const keys = (records: RecordSummary[]) => records.map(recordKey);

describe("mergeNewestPage", () => {
  it("puts new records ahead of the rows shown and keeps the pages already read", () => {
    const merged = mergeNewestPage([c, b, a], true, { records: [d, c], more: true });
    expect(keys(merged.records)).toEqual(keys([d, c, b, a]));
    expect(merged.more).toBe(true);
  });

  it("takes the page's word on whether more follow when it reaches past every row shown", () => {
    expect(mergeNewestPage([b], true, { records: [c, b, a], more: false }).more).toBe(false);
  });

  it("loses nothing to an older page that arrives after a newer one", () => {
    const merged = mergeNewestPage([d, c, b, a], true, { records: [c, b], more: true });
    expect(keys(merged.records)).toEqual(keys([d, c, b, a]));
    expect(merged.more).toBe(true);
  });

  it("takes the page's copy of a row it shares with the list", () => {
    const fresh = { ...c, title: "fresh" };
    expect(mergeNewestPage([c], false, { records: [fresh], more: false }).records[0]!.title).toBe("fresh");
  });

  it("orders a provider call ahead of a log line stored at the same time, as the database pages them", () => {
    const callAtB: RecordSummary = { ...b, kind: "provider-call", id: 1 };
    expect(keys(mergeNewestPage([b], false, { records: [callAtB], more: false }).records)).toEqual(
      keys([callAtB, b]),
    );
  });
});

describe("record formatting", () => {
  it("indents stored JSON and leaves other text as it is", () => {
    expect(blockText('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(blockText("not json")).toBe("not json");
  });

  it("gives no block text for a value that holds nothing", () => {
    for (const empty of [null, "", "  \n", "{}", "null", "[]", '""', '"  "']) expect(blockText(empty)).toBeNull();
  });

  it("keeps a value that holds something, however small", () => {
    expect(blockText("0")).toBe("0");
    expect(blockText("false")).toBe("false");
    expect(blockText('[""]')).toBe('[\n  ""\n]');
    expect(blockText('{"a":null}')).toBe('{\n  "a": null\n}');
  });

  it("continues after the last row shown, and from the start when there is none", () => {
    expect(cursorAfter([b, a])).toEqual({ time: a.time, kind: "log", id: 1 });
    expect(cursorAfter([])).toBeNull();
  });

  it("measures a call's duration in seconds", () => {
    expect(durationSeconds("2026-10-02T08:00:00.000Z", "2026-10-02T08:00:02.500Z")).toBe(2.5);
  });

  it("names the app's own purposes, and leaves any other to be shown as stored", () => {
    expect(purposeLabel("analysis")).toBe("tabs.analysis");
    expect(purposeLabel("metadata")).toBe("tabs.metadata");
    expect(purposeLabel("imaging")).toBe("tabs.imaging");
    expect(purposeLabel("toString")).toBeNull();
  });
});

describe("logEventText", () => {
  const time = "2026-10-02T08:00:30.000Z";
  const logRecord = (event: Record<string, unknown> | string, ids: Partial<LogRecordDetail> = {}): LogRecordDetail => ({
    kind: "log", id: 1, session: "s", time, level: "warn", message: "post save failed",
    workspaceId: "ws-1", postId: "post-1", ...ids,
    event: typeof event === "string" ? event : JSON.stringify(event),
  });
  const envelope = { time, level: "warn", message: "post save failed" };

  it("leaves out the fields the pane already shows", () => {
    const record = logRecord({ ...envelope, workspace: "ws-1", postId: "post-1", attempt: 2 });
    expect(logEventText(record)).toBe(JSON.stringify({ attempt: 2 }, null, 2));
  });

  it("gives nothing when every field is already shown", () => {
    expect(logEventText(logRecord({ ...envelope, workspaceId: "ws-1", postId: "post-1" }))).toBeNull();
    expect(logEventText(logRecord(envelope, { workspaceId: null, postId: null }))).toBeNull();
  });

  it("keeps a field of a shown name whose value the pane does not show", () => {
    const record = logRecord({ ...envelope, workspace: "ws-1", workspaceId: "ws-2" });
    expect(logEventText(record)).toBe(JSON.stringify({ workspaceId: "ws-2" }, null, 2));
  });

  it("shows a line that is not a JSON object as stored", () => {
    expect(logEventText(logRecord("not json"))).toBe("not json");
    expect(logEventText(logRecord("[1]"))).toBe("[\n  1\n]");
  });
});
