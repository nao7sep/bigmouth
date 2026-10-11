import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { message } from "@shared/i18n/translate";
const bridge = vi.hoisted(() => ({ get: vi.fn<() => Promise<boolean>>(), listeners: new Set<(pending: boolean) => void>() }));
vi.mock("@renderer/api", () => ({
  getStoragePending: bridge.get,
  onStoragePendingChanged: (listener: (pending: boolean) => void) => { bridge.listeners.add(listener); return () => bridge.listeners.delete(listener); },
  reportProblem: vi.fn(),
}));
import { StoragePendingNotice, StoragePendingProvider, StoragePendingResults, useStorageResultReporter } from "@renderer/StoragePending";
afterEach(() => { cleanup(); bridge.listeners.clear(); bridge.get.mockReset(); });
function Reporter() {
  const report = useStorageResultReporter();
  return <button onClick={() => report(message("app.storageChangeFailed"))}>Report</button>;
}
describe("storage settlement ownership", () => {
  it("subscribes before the initial read and ignores its stale result after an event", async () => {
    let initial!: (pending: boolean) => void;
    bridge.get.mockImplementation(() => {
      expect(bridge.listeners.size).toBe(1);
      return new Promise((resolve) => { initial = resolve; });
    });
    const view = render(<StoragePendingProvider><StoragePendingNotice /></StoragePendingProvider>);
    act(() => { for (const listener of bridge.listeners) listener(true); });
    await act(async () => { initial(false); });
    expect(view.getByRole("status").textContent).toContain("You can leave this view");
    act(() => { for (const listener of bridge.listeners) listener(false); });
    expect(view.queryByRole("status")).toBeNull();
    view.unmount();
    expect(bridge.listeners.size).toBe(0);
  });
  it("retains independent departed outcomes until each is dismissed", async () => {
    bridge.get.mockResolvedValue(false);
    const view = render(<StoragePendingProvider><Reporter /><StoragePendingResults /></StoragePendingProvider>);
    fireEvent.click(view.getByText("Report"));
    fireEvent.click(view.getByText("Report"));
    expect(view.getAllByRole("alert")).toHaveLength(2);
    fireEvent.click(view.getAllByRole("button", { name: "Close result" })[0]);
    expect(view.getAllByRole("alert")).toHaveLength(1);
    await act(async () => { await Promise.resolve(); });
  });
});
