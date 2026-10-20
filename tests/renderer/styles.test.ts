import { describe, expect, it } from "vitest";
import { lightTokens, topLevelDeclaration as declared } from "../appStylesheet";

const px = (value: string) => {
  expect(value, "a length in px").toMatch(/^\d+(\.\d+)?px$/);
  return Number.parseFloat(value);
};

// The web scroll bar's hit geometry, by the app-chrome rule: a 14-16px
// interactive gutter around an 8-10px visible rounded thumb, the breathing room
// between them being a transparent thumb border the background does not paint.
describe("renderer scrollbar contract", () => {
  it("keeps a 14-16px gutter around an 8-10px inset thumb", () => {
    const gutter = px(declared("*::-webkit-scrollbar", "width"));
    expect(px(declared("*::-webkit-scrollbar", "height"))).toBe(gutter);
    expect(gutter).toBeGreaterThanOrEqual(14);
    expect(gutter).toBeLessThanOrEqual(16);

    const thumb = "*::-webkit-scrollbar-thumb";
    expect(declared(thumb, "border-style")).toBe("solid");
    expect(declared(thumb, "border-color")).toBe("transparent");
    expect(declared(thumb, "background-clip")).toBe("padding-box");
    expect(declared(thumb, "border-radius")).not.toBe("");
    const visible = gutter - 2 * px(declared(thumb, "border-width"));
    expect(visible).toBeGreaterThanOrEqual(8);
    expect(visible).toBeLessThanOrEqual(10);

    expect(declared("*", "scrollbar-width")).toBe("auto");
  });

  it("uses strong ink tokens at rest and strengthens the whole owner in use", () => {
    expect(lightTokens.get("--bm-scrollbar-thumb")).toBe("var(--bm-text-muted)");
    expect(lightTokens.get("--bm-scrollbar-thumb-active")).toBe("var(--bm-text-soft)");

    expect(declared("*::-webkit-scrollbar-thumb", "background-color")).toBe("var(--bm-scrollbar-thumb)");
    expect(declared("*", "scrollbar-color")).toBe("var(--bm-scrollbar-thumb) transparent");
    for (const owner of ["*:hover::-webkit-scrollbar-thumb", "*:focus-within::-webkit-scrollbar-thumb"]) {
      expect(declared(owner, "background-color"), owner).toBe("var(--bm-scrollbar-thumb-active)");
    }
    for (const owner of ["*:hover", "*:focus-within"]) {
      expect(declared(owner, "scrollbar-color"), owner).toBe("var(--bm-scrollbar-thumb-active) transparent");
    }

    for (const region of ['[role="region"][tabindex="0"]', '[role="listbox"]', '[role="grid"]']) {
      expect(declared(region, "scrollbar-gutter"), region).toBe("stable");
    }
  });
});
