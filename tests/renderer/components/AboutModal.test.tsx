import { afterEach, describe, it, expect, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";

import { AboutModal } from "@renderer/components/AboutModal";

afterEach(cleanup);

describe("AboutModal", () => {
  it("renders the dialog with the app name, version and license", () => {
    const { getByRole, getByText } = render(<AboutModal onClose={vi.fn()} />);
    const dialog = getByRole("dialog");
    // The ModalShell title doubles as the dialog's accessible name.
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(document.getElementById(labelId!)?.textContent).toBe("About BigMouth");
    expect(getByText(/Version 0\.1\.0/)).toBeTruthy();
    expect(getByText(/MIT License/)).toBeTruthy();
  });

  it("links to the GitHub repo and its issues page, opening in a new tab", () => {
    const { getByText } = render(<AboutModal onClose={vi.fn()} />);
    const repo = getByText(/GitHub/).closest("a") as HTMLAnchorElement;
    const issues = getByText(/Report Issue/).closest("a") as HTMLAnchorElement;
    expect(repo.getAttribute("href")).toBe("https://github.com/nao7sep/bigmouth");
    expect(issues.getAttribute("href")).toBe("https://github.com/nao7sep/bigmouth/issues");
    // Outbound links must be safe (no opener leak) and open externally.
    for (const a of [repo, issues]) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noreferrer");
    }
  });

  it("autofocuses the close button so the keyboard lands on the only action", () => {
    const { getByLabelText } = render(<AboutModal onClose={vi.fn()} />);
    expect(document.activeElement).toBe(getByLabelText("Close"));
  });

  it("closes via the close button and via Escape", () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(<AboutModal onClose={onClose} />);
    fireEvent.click(getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
