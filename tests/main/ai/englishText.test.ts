// The threshold that decides whether a generated value is English or came back
// in the draft's language. It has to pass English prose that names something in
// its own script, and fail a value that IS in the other language — the gap
// between those two is the whole design, so both edges are pinned here.

import { describe, it, expect } from "vitest";
import { isEnglishScript } from "@main/core/ai/englishText.js";

describe("isEnglishScript", () => {
  it("accepts ordinary English", () => {
    expect(isEnglishScript("What the draft gets right about pacing")).toBe(true);
  });

  it("rejects a value written in another script", () => {
    expect(isEnglishScript("日本語のタイトルです")).toBe(false);
    expect(isEnglishScript("Заголовок на русском языке")).toBe(false);
    expect(isEnglishScript("이것은 한국어 제목입니다")).toBe(false);
  });

  it("accepts English carrying a name in its own script", () => {
    expect(isEnglishScript("What 鬼滅の刃 gets right about pacing")).toBe(true);
    expect(isEnglishScript("Reading Пушкин in translation")).toBe(true);
  });

  it("judges by letters, so punctuation and digits do not move the verdict", () => {
    // Same letters either way; only the script-neutral characters differ.
    expect(isEnglishScript("2026 — 100% (draft): pacing, craft; storytelling!")).toBe(true);
    expect(isEnglishScript("2026 — 100% (下書き): 構成、作画；物語！")).toBe(false);
  });

  it("passes a value with no letters to judge", () => {
    expect(isEnglishScript("2026")).toBe(true);
    expect(isEnglishScript("")).toBe(true);
  });
});
