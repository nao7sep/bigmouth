import { afterEach, describe, it, expect } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { message } from "@shared/i18n/translate";
import { StorageResults, StorageResultsProvider, useStorageResultReporter } from "@renderer/StorageResults";
afterEach(() => { cleanup(); });
function Reporter() {
  const report = useStorageResultReporter();
  return <button onClick={() => report(message("app.storageChangeFailed"))}>Report</button>;
}
describe("departed storage results", () => {
  it("retains independent departed outcomes until each is dismissed", () => {
    const view = render(<StorageResultsProvider><Reporter /><StorageResults /></StorageResultsProvider>);
    fireEvent.click(view.getByText("Report"));
    fireEvent.click(view.getByText("Report"));
    expect(view.getAllByRole("alert")).toHaveLength(2);
    fireEvent.click(view.getAllByRole("button", { name: "Close result" })[0]);
    expect(view.getAllByRole("alert")).toHaveLength(1);
  });
});
