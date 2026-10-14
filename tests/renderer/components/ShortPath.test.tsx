import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ShortPath } from "@renderer/components/ShortPath";

describe("ShortPath", () => {
  function parts(path: string) {
    const { container } = render(<ShortPath path={path} className="row-dir" />);
    const root = container.firstElementChild as HTMLElement;
    return {
      root,
      head: root.querySelector(".short-path-head")?.textContent ?? null,
      tail: root.querySelector(".short-path-tail")?.textContent ?? null,
    };
  }

  it("renders the head, then the final segment, and keeps the whole path", () => {
    const { root, head, tail } = parts("/Users/me/Documents/BigMouth/Alpha");
    expect(head).toBe("/Users/me/Documents/BigMouth/");
    expect(tail).toBe("Alpha");
    // Read whole by assistive technology, and on hover.
    expect(root.textContent).toBe("/Users/me/Documents/BigMouth/Alpha");
    expect(root.getAttribute("title")).toBe("/Users/me/Documents/BigMouth/Alpha");
    expect(root.className).toBe("short-path row-dir");
  });

  it("splits a Windows path at its backslashes", () => {
    const { head, tail } = parts("C:\\Users\\me\\BigMouth\\Alpha");
    expect(head).toBe("C:\\Users\\me\\BigMouth\\");
    expect(tail).toBe("Alpha");
  });

  it.each(["/", "C:\\", "Alpha"])("renders %j as a tail alone", (path) => {
    const { head, tail } = parts(path);
    expect(head).toBeNull();
    expect(tail).toBe(path);
  });
});
