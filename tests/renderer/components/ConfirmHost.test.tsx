import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { StoragePendingContext, StoragePendingProvider, StoragePendingResults, StoragePendingScope } from "@renderer/StoragePending";
import { ConfirmProvider, useConfirm, type ConfirmOptions } from "@renderer/components/ConfirmHost";

const pendingQuery = vi.hoisted(() => ({ pending: new Map<string | null, boolean>(), listeners: new Set<(pending: boolean) => void>() }));
vi.mock("@renderer/api", () => ({
  getStoragePending: vi.fn(async (workspaceId?: string | null) => pendingQuery.pending.get(workspaceId ?? null) ?? false),
  getDurabilityUnconfirmed: vi.fn().mockResolvedValue(false),
  onDurabilityUnconfirmed: vi.fn(() => () => {}),
  onStoragePendingChanged: (listener: (pending: boolean) => void) => { pendingQuery.listeners.add(listener); return () => { pendingQuery.listeners.delete(listener); }; },
  reportProblem: vi.fn(),
}));
beforeEach(() => { pendingQuery.pending.clear(); });
afterEach(() => { cleanup(); pendingQuery.listeners.clear(); });
async function setPending(workspaceId: string | null, pending: boolean) {
  await act(async () => {
    pendingQuery.pending.set(workspaceId, pending);
    for (const listener of pendingQuery.listeners) listener(pending);
  });
}

// A trivial consumer: clicking "ask" opens a confirm and reports its resolution.
function Harness({
  onResult,
  options = {},
}: {
  onResult: (result: boolean) => void;
  options?: Partial<ConfirmOptions>;
}) {
  const confirm = useConfirm();
  return (
    <button
      onClick={() => {
        void confirm({ message: "Proceed?", confirmLabel: "Yes", cancelLabel: "No", ...options }).then(onResult);
      }}
    >
      ask
    </button>
  );
}

function renderHost(onResult: (result: boolean) => void, options?: Partial<ConfirmOptions>) {
  return render(
    <ConfirmProvider>
      <Harness onResult={onResult} options={options} />
    </ConfirmProvider>,
  );
}

describe("ConfirmHost", () => {
  it("resolves true when the user confirms", async () => {
    const onResult = vi.fn();
    renderHost(onResult);
    fireEvent.click(screen.getByText("ask"));
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });

  it("resolves false when the user cancels", async () => {
    const onResult = vi.fn();
    renderHost(onResult);
    fireEvent.click(screen.getByText("ask"));
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it("settles every pending promise as false when the provider unmounts", async () => {
    const onResult = vi.fn();
    const { unmount } = renderHost(onResult);
    fireEvent.click(screen.getByText("ask"));
    // The dialog is open and the promise is still pending.
    expect(onResult).not.toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it("keeps the dialog open with an inline error when the action fails, then resolves true on a successful retry", async () => {
    const onResult = vi.fn();
    let attempts = 0;
    const onConfirm = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("delete failed");
    });
    renderHost(onResult, { onConfirm });

    fireEvent.click(screen.getByText("ask"));
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));

    // The failure is shown in the dialog and the promise stays unsettled.
    await screen.findByText("The action could not be completed. Nothing was changed; try again.");
    expect(screen.getByRole("alert").textContent).not.toContain("Error:");
    expect(onResult).not.toHaveBeenCalled();

    // Retrying succeeds → the dialog closes and the promise resolves true.
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});

describe("the confirm's message is announced with its title", () => {
  it("points aria-describedby at the message paragraph", async () => {
    // The message is the entire content of every confirm in the app and is what
    // the choice turns on, so a screen reader must read it with the title. No
    // dialog carried aria-describedby at all.
    renderHost(vi.fn(), { message: "Delete this post? This cannot be undone." });
    fireEvent.click(screen.getByText("ask"));

    const dialog = await screen.findByRole("dialog");
    const describedBy = dialog.getAttribute("aria-describedby");

    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      "Delete this post? This cannot be undone.",
    );
  });
});


it("lets a pending action leave without its late settlement closing the successor", async () => {
  let settle!: () => void;
  const onConfirm = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
  const firstResult = vi.fn();
  const secondResult = vi.fn();
  const contents = (pending: boolean) => <StoragePendingContext.Provider value={pending}>
    <ConfirmProvider>
      <Harness onResult={firstResult} options={{ message: "First?", onConfirm }} />
      <Harness onResult={secondResult} options={{ message: "Second?", confirmLabel: "Second" }} />
    </ConfirmProvider>
  </StoragePendingContext.Provider>;
  const view = render(contents(false));
  fireEvent.click(screen.getAllByText("ask")[0]);
  fireEvent.click(screen.getByRole("button", { name: "Yes" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getByText("First?")).toBeTruthy();
  view.rerender(contents(true));
  await setPending(null, true);
  // Queue the successor first, then deliver two close events before React
  // adopts the next head. The stale second callback must not consume it.
  fireEvent.click(screen.getAllByText("ask")[1]);
  const close = screen.getAllByRole("button", { name: "Close" }).at(-1)!;
  act(() => { fireEvent.click(close); fireEvent.click(close); });
  await waitFor(() => expect(firstResult).toHaveBeenCalledWith(false));
  expect(firstResult).toHaveBeenCalledOnce();
  await act(async () => { settle(); });
  expect(screen.getByText("Second?")).toBeTruthy();
  expect(secondResult).not.toHaveBeenCalled();
  expect(onConfirm).toHaveBeenCalledOnce();
});


it("reports a departed action failure without applying it to the successor dialog", async () => {
  let reject!: (error: Error) => void;
  const onConfirm = () => new Promise<void>((_resolve, fail) => { reject = fail; });
  const surface = (pending: boolean) => <StoragePendingProvider><StoragePendingContext.Provider value={pending}>
    <ConfirmProvider>
      <Harness onResult={vi.fn()} options={{ message: "First?", onConfirm }} />
      <Harness onResult={vi.fn()} options={{ message: "Second?" }} />
      <StoragePendingResults />
    </ConfirmProvider>
  </StoragePendingContext.Provider></StoragePendingProvider>;
  const view = render(surface(false));
  fireEvent.click(screen.getAllByText("ask")[0]);
  fireEvent.click(screen.getByRole("button", { name: "Yes" }));
  view.rerender(surface(true));
  await setPending(null, true);
  fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);
  fireEvent.click(screen.getAllByText("ask")[1]);
  await act(async () => { reject(new Error("store unavailable")); });
  expect(screen.getByRole("alert").textContent).toBe("The change could not be saved. Review it before trying again.");
  expect(screen.getByText("Second?")).toBeTruthy();
});


it("keeps a pure discard confirmation available while storage is pending", async () => {
  const onResult = vi.fn();
  render(<StoragePendingContext.Provider value={true}><ConfirmProvider>
    <Harness onResult={onResult} options={{ confirmLabel: "Discard" }} />
  </ConfirmProvider></StoragePendingContext.Provider>);
  fireEvent.click(screen.getByText("ask"));
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
});

it("retains the submitted confirmation's workspace after that view leaves", async () => {
  let settle!: () => void;
  const firstResult = vi.fn();
  const onConfirm = vi.fn(() => new Promise<void>(resolve => { settle = resolve; }));
  const content = (workspaceId: string) => <ConfirmProvider>
    <StoragePendingScope workspaceId={workspaceId}>
      <Harness onResult={firstResult} options={{ message: "Scoped action?", onConfirm }} />
    </StoragePendingScope>
  </ConfirmProvider>;
  const view = render(content("a"));
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(view.getByText("ask"));
  fireEvent.click(view.getByRole("button", { name: "Yes" }));
  view.rerender(content("b"));
  await setPending("a", true);
  const close = view.getAllByRole("button", { name: "Close" }).at(-1) as HTMLButtonElement;
  expect(close.disabled).toBe(false);
  fireEvent.click(close);
  await waitFor(() => expect(firstResult).toHaveBeenCalledWith(false));
  await act(async () => { settle(); });
  expect(view.queryByRole("dialog")).toBeNull();
});

it("keeps a workspace B confirmation usable while unrelated A is pending", async () => {
  pendingQuery.pending.set("a", true);
  const onConfirm = vi.fn(async () => {});
  const view = render(<ConfirmProvider><StoragePendingScope workspaceId="b">
    <Harness onResult={vi.fn()} options={{ onConfirm }} />
  </StoragePendingScope></ConfirmProvider>);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(view.getByText("ask"));
  await act(async () => { await Promise.resolve(); });
  const confirm = view.getByRole("button", { name: "Yes" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(false);
  await act(async () => { fireEvent.click(confirm); });
  expect(onConfirm).toHaveBeenCalledOnce();
});
