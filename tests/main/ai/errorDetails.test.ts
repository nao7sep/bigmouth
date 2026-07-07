import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeAiError, aiErrorMessage, logAiFailure } from "@main/core/ai/errorDetails.js";
import { initLogger, closeLogger, getCurrentLogFilePath } from "@main/core/services/logger.js";

function readLogLines(): Record<string, unknown>[] {
  const filePath = getCurrentLogFilePath();
  if (!filePath) throw new Error("logger not initialized");
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("describeAiError", () => {
  it("returns only the serialized error for a plain Error", () => {
    const details = describeAiError(new Error("boom"));
    expect(Object.keys(details)).toEqual(["error"]);
    const inner = details.error as Record<string, unknown>;
    expect(inner.name).toBe("Error");
    expect(inner.message).toBe("boom");
    expect(typeof inner.stack).toBe("string");
  });

  it("captures status, error type, and request id from an SDK-style error", () => {
    const err = Object.assign(new Error("rate limited"), {
      status: 429,
      type: "rate_limit_error",
      requestID: "req_123",
    });
    const out = describeAiError(err);
    expect(out.status).toBe(429);
    expect(out.providerErrorType).toBe("rate_limit_error");
    expect(out.providerRequestId).toBe("req_123");
    expect((out.error as Record<string, unknown>).message).toBe("rate limited");
  });

  it("reads the error type from a nested error object", () => {
    const err = Object.assign(new Error("bad"), {
      error: { type: "invalid_request_error" },
    });
    const out = describeAiError(err);
    expect(out.providerErrorType).toBe("invalid_request_error");
    expect(out.providerError).toEqual({ type: "invalid_request_error" });
  });

  it("accepts alternate request-id field names", () => {
    expect(describeAiError(Object.assign(new Error("x"), { _request_id: "req_abc" })).providerRequestId).toBe(
      "req_abc"
    );
    expect(describeAiError(Object.assign(new Error("y"), { request_id: "req_def" })).providerRequestId).toBe(
      "req_def"
    );
  });

  it("captures a nested cause chain with full fidelity", () => {
    const err = new Error("outer", { cause: new Error("inner") });
    const out = describeAiError(err);
    const cause = (out.error as Record<string, unknown>).cause as Record<string, unknown>;
    expect(cause.message).toBe("inner");
  });

  it("describes a non-Error thrown value", () => {
    const out = describeAiError("just a string");
    expect(out.error).toEqual({ message: "just a string" });
  });
});

describe("aiErrorMessage", () => {
  it("uses .message for Errors and String() otherwise", () => {
    expect(aiErrorMessage(new Error("boom"))).toBe("boom");
    expect(aiErrorMessage("raw string")).toBe("raw string");
  });
});

describe("logAiFailure", () => {
  let logsDir: string;

  beforeEach(() => {
    logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-aierr-"));
    initLogger(logsDir);
  });

  afterEach(() => {
    closeLogger();
    fs.rmSync(logsDir, { recursive: true, force: true });
  });

  it("logs one structured error record and returns the HTTP fallback message", () => {
    const returned = logAiFailure(
      {
        kind: "Analysis",
        requestId: "req-1",
        workspaceId: "ws-1",
        postId: "p-1",
        promptName: "tone",
        extra: { contentLength: 1200, apiKey: "sk-should-be-hidden" },
      },
      new Error("model failed")
    );

    expect(returned).toBe("model failed");

    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.level).toBe("error");
    expect(line.message).toBe("Analysis failed");
    expect(line.requestId).toBe("req-1");
    expect(line.workspaceId).toBe("ws-1");
    expect(line.postId).toBe("p-1");
    expect(line.promptName).toBe("tone");
    expect(line.contentLength).toBe(1200);
    // The redactor catches a denied key even when it rides in via `extra`.
    expect(line.apiKey).toBe("[redacted]");
    expect((line.error as Record<string, unknown>).message).toBe("model failed");
  });

  it("captures unparseable raw output as a single field, not a multi-line block", () => {
    const raw = "line one\nline two\nnot json";
    logAiFailure({ kind: "Imaging", postId: "p-2" }, new Error("bad json"), raw);

    const lines = readLogLines();
    // One physical line for the whole event, newlines escaped inside the JSON.
    expect(lines).toHaveLength(1);
    expect(lines[0].rawResponse).toBe(raw);
    expect(lines[0].rawResponseLength).toBe(raw.length);
  });
});
