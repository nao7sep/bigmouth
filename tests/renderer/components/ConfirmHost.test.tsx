import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ConfirmProvider, useConfirm, type ConfirmOptions } from "@renderer/components/ConfirmHost";

afterEach(cleanup);

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
    await screen.findByText("delete failed");
    expect(onResult).not.toHaveBeenCalled();

    // Retrying succeeds → the dialog closes and the promise resolves true.
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});
