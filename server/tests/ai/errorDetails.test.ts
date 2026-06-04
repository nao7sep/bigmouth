import { describe, it, expect } from "vitest";
import { describeAiError } from "../../src/../src/ai/errorDetails.js";

describe("describeAiError", () => {
  it("describes a plain Error by message", () => {
    expect(describeAiError(new Error("boom"))).toBe("message=boom");
  });

  it("includes status, type, and requestId from an SDK-style error", () => {
    const err = Object.assign(new Error("rate limited"), {
      status: 429,
      type: "rate_limit_error",
      requestID: "req_123",
    });
    const out = describeAiError(err);
    expect(out).toContain("message=rate limited");
    expect(out).toContain("status=429");
    expect(out).toContain("type=rate_limit_error");
    expect(out).toContain("requestId=req_123");
  });

  it("reads the type from a nested error object", () => {
    const err = Object.assign(new Error("bad"), {
      error: { type: "invalid_request_error" },
    });
    expect(describeAiError(err)).toContain("type=invalid_request_error");
  });

  it("accepts alternate request-id field names", () => {
    const err = Object.assign(new Error("x"), { _request_id: "req_abc" });
    expect(describeAiError(err)).toContain("requestId=req_abc");
  });

  it("includes a nested cause message", () => {
    const err = Object.assign(new Error("outer"), {
      cause: new Error("inner"),
    });
    expect(describeAiError(err)).toContain("cause=inner");
  });

  it("stringifies a non-Error value", () => {
    expect(describeAiError("just a string")).toBe("message=just a string");
  });
});
