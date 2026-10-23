import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { message } from "@shared/i18n/translate";
const bridge = vi.hoisted(() => ({ get: vi.fn<(workspaceId?: string | null) => Promise<boolean>>(), durability: vi.fn<() => Promise<boolean>>().mockResolvedValue(false), durabilityListeners: new Set<() => void>(), listeners: new Set<(pending: boolean) => void>() }));
vi.mock("@renderer/api", () => ({
  getStoragePending: bridge.get,
  getDurabilityUnconfirmed: bridge.durability,
  onDurabilityUnconfirmed: (listener: () => void) => { bridge.durabilityListeners.add(listener); return () => bridge.durabilityListeners.delete(listener); },
  onStoragePendingChanged: (listener: (pending: boolean) => void) => { bridge.listeners.add(listener); return () => bridge.listeners.delete(listener); },
  reportProblem: vi.fn(),
}));
import { StoragePendingNotice, StoragePendingProvider, StoragePendingResults, StoragePendingScope, useStoragePending, useStoragePendingFor, useStorageResultReporter } from "@renderer/StoragePending";
afterEach(() => { cleanup(); bridge.listeners.clear(); bridge.get.mockReset(); bridge.durability.mockReset().mockResolvedValue(false); bridge.durabilityListeners.clear(); });
function Reporter() {
  const report = useStorageResultReporter();
  return <button onClick={() => report(message("app.storageChangeFailed"))}>Report</button>;
}
describe("storage settlement ownership", () => {
  it("subscribes before the initial read and ignores its stale result after an event", async () => {
    let initial!: (pending: boolean) => void;
    bridge.get.mockImplementationOnce(() => {
      expect(bridge.listeners.size).toBe(1);
      return new Promise((resolve) => { initial = resolve; });
    }).mockResolvedValueOnce(true).mockResolvedValue(false);
    const view = render(<StoragePendingProvider><StoragePendingNotice /></StoragePendingProvider>);
    await act(async () => { for (const listener of bridge.listeners) listener(false); });
    await act(async () => { initial(false); });
    expect(view.getByRole("status").textContent).toContain("You can leave this view");
    await act(async () => { for (const listener of bridge.listeners) listener(true); });
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

it("retains a durability notice across stale initial reads and releases the listener", async () => {
  bridge.get.mockResolvedValue(false);
  let initial!: (value: boolean) => void;
  bridge.durability.mockImplementation(() => new Promise(resolve => { initial = resolve; }));
  const view = render(<StoragePendingProvider><StoragePendingNotice /></StoragePendingProvider>);
  act(() => { for (const listener of bridge.durabilityListeners) listener(); });
  await act(async () => { initial(false); });
  expect(view.getByRole("status").textContent).toContain("protection against power loss could not be confirmed");
  view.unmount();
  expect(bridge.durabilityListeners.size).toBe(0);
});
it("shows the retained durability notice when the window opens after publication", async () => {
  bridge.get.mockResolvedValue(false);
  bridge.durability.mockResolvedValue(true);
  const view = render(<StoragePendingProvider><StoragePendingNotice /></StoragePendingProvider>);
  await act(async () => { await Promise.resolve(); });
  expect(view.getByRole("status").textContent).toContain("Changes were saved");
});

function ScopedPending({ name }: { name: string }) {
  const pending = useStoragePending();
  return <button disabled={pending}>{name}</button>;
}

it("isolates pending workspace A from B and local workspace management", async () => {
  bridge.get.mockImplementation(async (workspaceId) => workspaceId === "a");
  const view = render(<StoragePendingProvider>
    <ScopedPending name="Local" />
    <StoragePendingScope workspaceId="a"><ScopedPending name="A" /></StoragePendingScope>
    <StoragePendingScope workspaceId="b"><ScopedPending name="B" /></StoragePendingScope>
  </StoragePendingProvider>);
  await act(async () => { await Promise.resolve(); });
  expect((view.getByRole("button", { name: "A" }) as HTMLButtonElement).disabled).toBe(true);
  expect((view.getByRole("button", { name: "B" }) as HTMLButtonElement).disabled).toBe(false);
  expect((view.getByRole("button", { name: "Local" }) as HTMLButtonElement).disabled).toBe(false);
  expect(bridge.get).toHaveBeenCalledWith(null);
  expect(bridge.get).toHaveBeenCalledWith("a");
  expect(bridge.get).toHaveBeenCalledWith("b");
});

it("resets on scope change and rejects stale scope and invalidation replies", async () => {
  const answers: Array<{ scope: string | null | undefined; resolve: (value: boolean) => void }> = [];
  bridge.get.mockImplementation((scope) => new Promise(resolve => { answers.push({ scope, resolve }); }));
  function Pending({ workspaceId }: { workspaceId: string }) {
    return <output data-testid="pending">{String(useStoragePendingFor(workspaceId))}</output>;
  }
  const view = render(<Pending workspaceId="a" />);
  await act(async () => { answers[0]!.resolve(true); });
  expect(view.getByTestId("pending").textContent).toBe("true");
  act(() => { for (const listener of bridge.listeners) listener(true); });
  view.rerender(<Pending workspaceId="b" />);
  expect(view.getByTestId("pending").textContent).toBe("false");
  await act(async () => { answers[1]!.resolve(true); });
  expect(view.getByTestId("pending").textContent).toBe("false");
  act(() => { for (const listener of bridge.listeners) listener(false); });
  await act(async () => { answers[3]!.resolve(false); answers[2]!.resolve(true); });
  expect(view.getByTestId("pending").textContent).toBe("false");
});
