import { describe, it, expect } from "vitest";
import { formatLogValue } from "../../src/../src/services/logger.js";

// formatLogValue returns a JSON string; parse it back to assert structure.
function summarized(value: unknown): unknown {
  return JSON.parse(formatLogValue(value));
}

describe("formatLogValue redaction", () => {
  it("redacts sensitive top-level keys and keeps the rest", () => {
    const out = summarized({
      apiKey: "sk-ant-secret",
      authorization: "Bearer abc",
      token: "tok_123",
      password: "hunter2",
      secret: "s3cr3t",
      model: "claude-opus-4-8",
    }) as Record<string, unknown>;

    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.authorization).toBe("[REDACTED]");
    expect(out.token).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
    expect(out.secret).toBe("[REDACTED]");
    expect(out.model).toBe("claude-opus-4-8");
  });

  it("never lets a redacted value reach the output string", () => {
    const raw = formatLogValue({ apiKey: "sk-ant-leak-me" });
    expect(raw).not.toContain("sk-ant-leak-me");
  });

  it("redacts a sensitive key nested one level deep", () => {
    const out = summarized({ config: { apiKey: "sk-ant-nested" } }) as {
      config: Record<string, unknown>;
    };
    expect(out.config.apiKey).toBe("[REDACTED]");
    expect(formatLogValue({ config: { apiKey: "sk-ant-nested" } })).not.toContain(
      "sk-ant-nested"
    );
  });
});

describe("formatLogValue summarization", () => {
  it("truncates a long string and reports its length", () => {
    const long = "x".repeat(200);
    const out = summarized(long) as string;
    expect(out.endsWith("[200 chars]")).toBe(true);
    expect(out.length).toBeLessThan(200);
  });

  it("normalizes whitespace in strings", () => {
    expect(summarized("  a   b\n\tc  ")).toBe("a b c");
  });

  it("truncates a long array and notes how many were dropped", () => {
    const arr = Array.from({ length: 15 }, (_, i) => i);
    const out = summarized(arr) as unknown[];
    expect(out).toHaveLength(11); // 10 items + 1 marker
    expect(out[10]).toBe("… [5 more]");
  });

  it("caps object keys at 20 with a truncation marker", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 25; i++) big[`k${i}`] = i;
    const out = summarized(big) as Record<string, unknown>;
    expect(out.__truncated).toBe("5 more keys");
  });

  it("passes primitive values through unchanged", () => {
    expect(summarized(42)).toBe(42);
    expect(summarized(true)).toBe(true);
    expect(summarized(null)).toBeNull();
  });
});
