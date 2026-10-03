import { describe, expect, it } from "vitest";

import { cursorAfter, durationSeconds, mergeNewestPage, prettyJson, purposeLabel, recordKey } from "@renderer/records/recordFormat";
import type { RecordSummary } from "@shared/records";

const row = (id: number, time: string, title = `row ${id}`): RecordSummary => ({
  kind: "log", id, session: "s", time, level: "info", title, text: null,
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
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson("not json")).toBe("not json");
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
