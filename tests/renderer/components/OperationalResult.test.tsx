import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OperationalResult } from "@renderer/components/OperationalResult";

describe("OperationalResult", () => {
  it("announces an error without redundant visible or spoken severity", () => {
    const onDismiss = vi.fn();
    const { getByRole, container } = render(
      <OperationalResult
        severity="error"
        className="local-error"
        dismissClassName="local-error-dismiss"
        onDismiss={onDismiss}
      >
        Save failed
      </OperationalResult>,
    );

    const result = getByRole("alert");
    expect(result.getAttribute("aria-atomic")).toBe("true");
    expect(result.textContent).toBe("Save failed");
    expect(container.querySelector('[data-icon="error"]')).toBeNull();
    fireEvent.click(getByRole("button", { name: "Close result" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("announces a warning politely with a visible warning cue", () => {
    const { getByRole, container } = render(
      <OperationalResult severity="warning" className="local-warning">
        Some files need attention
      </OperationalResult>,
    );

    expect(getByRole("status").textContent).toBe("Some files need attention");
    expect(container.querySelector('[data-icon="warning"]')).toBeNull();
  });
});
