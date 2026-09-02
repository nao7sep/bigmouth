import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => {
  let loadError: Error | null = null;
  let measurementError: Error | null = null;
  let lastWindow: MockBrowserWindow | null = null;

  class MockBrowserWindow {
    static getFocusedWindow = () => null;
    private closedHandler: (() => void) | null = null;
    private domReadyHandler: (() => void) | null = null;
    private destroyed = false;

    webContents = {
      on: vi.fn(),
      once: vi.fn((event: string, handler: () => void) => {
        if (event === "dom-ready") this.domReadyHandler = handler;
      }),
      executeJavaScript: vi.fn(() =>
        measurementError ? Promise.reject(measurementError) : Promise.resolve(240),
      ),
    };

    constructor(_options: unknown) {
      lastWindow = this;
    }

    on(event: string, handler: () => void): void {
      if (event === "closed") this.closedHandler = handler;
    }

    loadURL(): Promise<void> {
      return loadError ? Promise.reject(loadError) : Promise.resolve();
    }

    isDestroyed(): boolean { return this.destroyed; }
    close(): void {
      this.destroyed = true;
      this.closedHandler?.();
    }
    setContentSize(): void {}
    show(): void {}
    triggerDomReady(): void { this.domReadyHandler?.(); }
  }

  return {
    BrowserWindow: MockBrowserWindow,
    setLoadError(error: Error | null) { loadError = error; },
    setMeasurementError(error: Error | null) { measurementError = error; },
    getLastWindow() { return lastWindow; },
  };
});

vi.mock("electron", () => ({ BrowserWindow: electronMock.BrowserWindow }));

import { showPlainMessageDialog } from "@main/plain-message-dialog";

describe("plain message dialog settlement", () => {
  beforeEach(() => {
    electronMock.setLoadError(null);
    electronMock.setMeasurementError(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("settles through the safe cancel choice when the dialog document cannot load", async () => {
    electronMock.setLoadError(new Error("EACCES IPC /private/tmp/BIGMOUTH-DIALOG-SENTINEL"));

    const choice = await showPlainMessageDialog({
      title: "Unsaved changes",
      message: "Choose",
      buttons: ["Cancel", "Quit Anyway"],
      defaultId: 0,
      cancelId: 0,
    });

    expect(choice).toBe(0);
    expect(console.error).toHaveBeenCalledWith(
      "[bigmouth] message dialog load failed:",
      expect.any(Error),
    );
  });

  it("settles through cancel when content measurement rejects before the window is shown", async () => {
    electronMock.setMeasurementError(new Error("renderer gone"));
    const pending = showPlainMessageDialog({
      title: "Unsaved changes",
      message: "Choose",
      buttons: ["Cancel", "Quit Anyway"],
      cancelId: 0,
    });

    electronMock.getLastWindow()?.triggerDomReady();

    await expect(pending).resolves.toBe(0);
  });
});
