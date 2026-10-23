import { expect, it, vi } from "vitest";
import { storageTasks } from "@main/storageTasks.js";
import { storeLogRecord } from "@main/core/services/logger.js";
import type { LogRecord } from "@main/core/services/recordsStore.js";

vi.mock("@main/core/services/logger.js", async (original) => ({
  ...await original<typeof import("@main/core/services/logger.js")>(),
  storeLogRecord: vi.fn(),
}));

it("delivers the main process's complete log record unchanged on the storage worker", () => {
  const record: LogRecord = {
    time: "2026-10-23T03:04:05.123Z", level: "debug", message: "event at origin",
    workspaceId: "workspace", postId: "post",
    event: JSON.stringify({ time: "2026-10-23T03:04:05.123Z", level: "debug", message: "event at origin" }),
  };
  storageTasks.log(record);
  expect(storeLogRecord).toHaveBeenCalledExactlyOnceWith(record);
  expect(vi.mocked(storeLogRecord).mock.calls[0][0]).toBe(record);
});
