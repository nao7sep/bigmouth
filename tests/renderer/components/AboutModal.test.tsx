import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { BigMouthApi } from "@shared/ipc";

import { AboutModal } from "@renderer/components/AboutModal";

const openExternal = vi.fn<BigMouthApi["openExternal"]>();
const writeRendererLog = vi.fn<BigMouthApi["writeRendererLog"]>();

beforeEach(() => {
  openExternal.mockReset();
  openExternal.mockResolvedValue();
  writeRendererLog.mockReset();
  Object.defineProperty(window, "bigmouth", {
    configurable: true,
    value: { openExternal, writeRendererLog } satisfies Partial<BigMouthApi>,
  });
});

afterEach(cleanup);

// The version is single-sourced from package.json (mirrored into __APP_VERSION__ by
// vitest.config.ts); read it the same way so this test never needs a manual edit on a bump.
// Uses node:url's own URL (not the jsdom-environment global, which resolves a relative
// `import.meta.url` base against `window.location` instead) to locate the file.
const { version: APP_VERSION } = JSON.parse(
  readFileSync(new NodeURL("../../../package.json", import.meta.url), "utf8"),
);

describe("AboutModal", () => {
  it("renders the dialog with the app name, version and license", () => {
    const { getByRole, getByText } = render(<AboutModal onClose={vi.fn()} />);
    const dialog = getByRole("dialog");
    // The ModalShell title doubles as the dialog's accessible name.
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(document.getElementById(labelId!)?.textContent).toBe("About BigMouth");
    expect(getByText(new RegExp(`Version ${APP_VERSION.replace(/\./g, "\\.")}`))).toBeTruthy();
    expect(getByText(/MIT License/)).toBeTruthy();
  });

  it("routes the GitHub repo and issues page through the rejectable desktop bridge", async () => {
    const { getByText } = render(<AboutModal onClose={vi.fn()} />);
    const repo = getByText(/GitHub/).closest("a") as HTMLAnchorElement;
    const issues = getByText(/Report Issue/).closest("a") as HTMLAnchorElement;
    expect(repo.getAttribute("href")).toBe("https://github.com/nao7sep/bigmouth");
    expect(issues.getAttribute("href")).toBe("https://github.com/nao7sep/bigmouth/issues");
    // The href remains inspectable, while the click is owned by the desktop bridge.
    for (const a of [repo, issues]) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noreferrer");
    }
    fireEvent.click(repo);
    fireEvent.click(issues);
    await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(2));
    expect(openExternal).toHaveBeenNthCalledWith(1, "https://github.com/nao7sep/bigmouth");
    expect(openExternal).toHaveBeenNthCalledWith(2, "https://github.com/nao7sep/bigmouth/issues");
  });

  it("retains independent authored link failures and clears only the matching success", async () => {
    const hostile = new Error("EACCES /private/tmp/hostile-ipc-path");
    openExternal.mockRejectedValueOnce(hostile).mockRejectedValueOnce(hostile);
    const { getByRole, getByText, getAllByLabelText, queryByText } = render(<AboutModal onClose={vi.fn()} />);

    fireEvent.click(getByText(/GitHub/).closest("a")!);
    fireEvent.click(getByText(/Report Issue/).closest("a")!);
    await waitFor(() => {
      expect(getByText("GitHub could not be opened. Try again.")).toBeTruthy();
      expect(getByText("Report Issue could not be opened. Try again.")).toBeTruthy();
    });
    expect(document.body.textContent).not.toContain("EACCES");
    expect(document.body.textContent).not.toContain("/private/tmp");
    expect(writeRendererLog).toHaveBeenCalledTimes(2);

    openExternal.mockResolvedValueOnce();
    fireEvent.click(getByRole("link", { name: /^GitHub/ }));
    await waitFor(() => expect(queryByText("GitHub could not be opened. Try again.")).toBeNull());
    expect(getByText("Report Issue could not be opened. Try again.")).toBeTruthy();

    fireEvent.click(getAllByLabelText("Close result")[0]);
    expect(queryByText("Report Issue could not be opened. Try again.")).toBeNull();
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
