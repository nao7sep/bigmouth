import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OperationalResult } from "@renderer/components/OperationalResult";

describe("OperationalResult", () => {
  it("makes an error persistent, structural, and assertively announced", () => {
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
    expect(result.textContent).toContain("Error: Save failed");
    expect(container.querySelector('[data-icon="error"]')).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Dismiss error" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("announces a warning politely with a visible warning cue", () => {
    const { getByRole, container } = render(
      <OperationalResult severity="warning" className="local-warning">
        Some files need attention
      </OperationalResult>,
    );

    expect(getByRole("status").textContent).toContain("Warning: Some files need attention");
    expect(container.querySelector('[data-icon="warning"]')).toBeTruthy();
  });
});
