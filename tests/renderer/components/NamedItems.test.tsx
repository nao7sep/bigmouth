import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ListedMessageView, fewNamesText, type NamedItem } from "@renderer/components/NamedItems";
import { createTranslator } from "@renderer/i18n/I18nContext";
import { loadCatalogue } from "@shared/i18n/catalogues";
import { message } from "@shared/i18n/translate";

beforeAll(async () => {
  await Promise.all([loadCatalogue("de"), loadCatalogue("ja")]);
});
afterEach(cleanup);

const files = (count: number): NamedItem[] =>
  Array.from({ length: count }, (_, index) => ({
    name: `post-${index + 1}.md`,
    line: message("store.unreadable", { path: `/d/a/posts/post-${index + 1}.md` }),
  }));

describe("fewNamesText", () => {
  it("lists every name when there are three or fewer", () => {
    expect(fewNamesText(createTranslator("en"), ["a.md", "b.md"])).toBe("a.md, b.md");
  });

  it("names three and counts the rest", () => {
    expect(fewNamesText(createTranslator("en"), ["a.md", "b.md", "c.md", "d.md", "e.md"])).toBe("a.md, b.md, c.md and 2 more");
  });

  // The language's list would add its own "und" before the last name, and the
  // count sentence adds another.
  it("says the conjunction once", () => {
    expect(fewNamesText(createTranslator("de"), ["a.md", "b.md", "c.md", "d.md"])).toBe("a.md, b.md, c.md und 1 weitere");
    expect(fewNamesText(createTranslator("ja"), ["a.md", "b.md", "c.md", "d.md"])).toBe("a.md、b.md、c.md ほか 1 件");
  });
});

describe("ListedMessageView", () => {
  it("names at most three items and counts the rest", () => {
    const { container } = render(
      <ListedMessageView listed={{ message: message("session.unreadablePosts", { count: 5 }), items: files(5) }} />,
    );
    expect(container.textContent).toContain("5 post files are not in the list because BigMouth could not read them:");
    expect(container.querySelector(".named-items-summary")?.textContent).toBe("post-1.md, post-2.md, post-3.md and 2 more");
  });

  it("lists every item whole behind a disclosure", () => {
    const { container, getByText } = render(
      <ListedMessageView listed={{ message: message("session.unreadablePosts", { count: 5 }), items: files(5) }} />,
    );
    const details = container.querySelector("details.named-items") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const items = [...details.querySelectorAll(".named-items-list li")].map((item) => item.textContent);
    expect(items).toHaveLength(5);
    expect(items[4]).toBe("BigMouth could not read /d/a/posts/post-5.md, so the file was left unchanged. Repair or move it, then try again.");
    // A native disclosure, so keyboard and touch open it like a click.
    fireEvent.click(getByText("Full list"));
    expect(details.open).toBe(true);
  });

  it("keeps the disclosure for a single item whose line says more than its name", () => {
    const { container } = render(
      <ListedMessageView listed={{ message: message("assets.notAdded", { count: 1 }), items: [{ name: "bad.png", line: message("assets.itemReason", { name: "bad.png", reason: message("assets.fileNotAdded") }) }] }} />,
    );
    expect(container.querySelector(".named-items-summary")?.textContent).toBe("bad.png");
    expect(container.querySelector(".named-items-list li")?.textContent).toMatch(/^bad\.png: The file could not be added/);
  });

  it("leaves the disclosure out when the items are names alone", () => {
    const { container } = render(
      <ListedMessageView listed={{ message: message("assets.notAdded", { count: 2 }), items: [{ name: "a.png" }, { name: "b.png" }] }} />,
    );
    expect(container.querySelector(".named-items-summary")?.textContent).toBe("a.png, b.png");
    expect(container.querySelector("details")).toBeNull();
  });

  it("puts the summary in the sentence's own placeholder", () => {
    const names = ["a.png", "b.png", "c.png", "d.png"].map((name) => ({ name }));
    const { container } = render(
      <ListedMessageView listed={{ message: message("assets.collision"), items: names, namesIn: "names" }} />,
    );
    expect(container.textContent).toContain("resolve to the same asset name (a.png, b.png, c.png and 1 more)");
    expect(container.querySelector(".named-items-summary")).toBeNull();
    // Names alone, past the count, are not repeated behind a disclosure.
    expect(container.querySelector("details")).toBeNull();
  });

  it("is the plain sentence when no items are given", () => {
    const { container } = render(<ListedMessageView listed={{ message: message("assets.addFailed") }} />);
    expect(container.textContent).toBe("Assets could not be added. The current asset list is unchanged; try again.");
  });
});
