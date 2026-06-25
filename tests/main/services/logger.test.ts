import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initLogger,
  closeLogger,
  getCurrentLogFilePath,
  debug,
  info,
  warn,
  error,
  isDebugLoggingEnabled,
  redact,
  serializeError,
} from "../../src/../src/services/logger.js";

// Reads every JSON object written to the current session log file.
function readLogLines(): Record<string, unknown>[] {
  const filePath = getCurrentLogFilePath();
  if (!filePath) throw new Error("logger not initialized");
  const raw = fs.readFileSync(filePath, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

let logsDir: string;

beforeEach(() => {
  logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-log-"));
  initLogger(logsDir);
  delete process.env.BIGMOUTH_DEBUG;
});

afterEach(() => {
  closeLogger();
  delete process.env.BIGMOUTH_DEBUG;
  fs.rmSync(logsDir, { recursive: true, force: true });
});

describe("session file", () => {
  it("names the file with the UTC session-start stamp and nothing else", () => {
    const filePath = getCurrentLogFilePath();
    expect(filePath).not.toBeNull();
    expect(path.basename(filePath as string)).toMatch(/^\d{8}-\d{6}-utc\.log$/);
  });
});

describe("envelope", () => {
  it("writes one JSON object per line with time / level / message", () => {
    info("hello world");
    const [line] = readLogLines();
    expect(line.level).toBe("info");
    expect(line.message).toBe("hello world");
    expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("uses lowercase level names for each level", () => {
    process.env.BIGMOUTH_DEBUG = "1";
    debug("d");
    info("i");
    warn("w");
    error("e");
    expect(readLogLines().map((l) => l.level)).toEqual(["debug", "info", "warn", "error"]);
  });

  it("merges extra fields alongside the envelope", () => {
    info("did a thing", { count: 3, ok: true, items: ["a", "b"] });
    const [line] = readLogLines();
    expect(line.count).toBe(3);
    expect(line.ok).toBe(true);
    expect(line.items).toEqual(["a", "b"]);
  });

  it("never lets a field overwrite the envelope time / level / message", () => {
    info("real message", { message: "spoofed", level: "error", time: "nope" });
    const [line] = readLogLines();
    expect(line.message).toBe("real message");
    expect(line.level).toBe("info");
    expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("debug gating", () => {
  it("is silent unless debug logging is enabled", () => {
    debug("should not appear");
    info("marker");
    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe("marker");
  });

  it("emits when BIGMOUTH_DEBUG=1", () => {
    process.env.BIGMOUTH_DEBUG = "1";
    debug("now visible");
    const [line] = readLogLines();
    expect(line.level).toBe("debug");
    expect(line.message).toBe("now visible");
  });

  it("emits when --debug-logs is present in process arguments", () => {
    const originalArgv = process.argv;
    try {
      process.argv = [...originalArgv, "--debug-logs"];
      debug("cli visible");
    } finally {
      process.argv = originalArgv;
    }
    const [line] = readLogLines();
    expect(line.level).toBe("debug");
    expect(line.message).toBe("cli visible");
  });

  it("enables debug logging only for explicit switches", () => {
    expect(isDebugLoggingEnabled({ env: {}, argv: ["node", "index.js"] })).toBe(false);
    expect(isDebugLoggingEnabled({ env: { BIGMOUTH_DEBUG: "1" }, argv: ["node", "index.js"] })).toBe(
      true
    );
    expect(isDebugLoggingEnabled({ env: {}, argv: ["node", "index.js", "--debug-logs"] })).toBe(true);
    expect(isDebugLoggingEnabled({ env: {}, argv: ["node", "index.js", "--debug-logs=false"] })).toBe(
      false
    );
  });
});

describe("redaction", () => {
  it("replaces the value of denied keys with the marker, case-insensitively", () => {
    const out = redact({
      apiKey: "sk-1",
      Authorization: "Bearer x",
      TOKEN: "t",
      password: "p",
      Secret: "s",
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe("[redacted]");
    expect(out.Authorization).toBe("[redacted]");
    expect(out.TOKEN).toBe("[redacted]");
    expect(out.password).toBe("[redacted]");
    expect(out.Secret).toBe("[redacted]");
  });

  it("matches whole field names only — never substrings", () => {
    const out = redact({ tokenCount: 5, broken: "no", token: "yes" }) as Record<string, unknown>;
    expect(out.tokenCount).toBe(5);
    expect(out.broken).toBe("no");
    expect(out.token).toBe("[redacted]");
  });

  it("recurses through nested objects and arrays", () => {
    const out = redact({
      config: { apiKey: "deep" },
      list: [{ password: "p" }, { keep: 1 }],
    }) as { config: Record<string, unknown>; list: Record<string, unknown>[] };
    expect(out.config.apiKey).toBe("[redacted]");
    expect(out.list[0].password).toBe("[redacted]");
    expect(out.list[1].keep).toBe(1);
  });

  it("is type-preserving and never scans string contents", () => {
    const out = redact({ note: "my password is hunter2", n: 42, arr: [1, 2] }) as Record<
      string,
      unknown
    >;
    // The value contains the word "password" but the KEY is not denied — untouched.
    expect(out.note).toBe("my password is hunter2");
    expect(out.n).toBe(42);
    expect(Array.isArray(out.arr)).toBe(true);
  });

  it("never edits the envelope message even when a denied key is present", () => {
    info("password reset for user", { password: "hunter2", user: "ann" });
    const [line] = readLogLines();
    expect(line.message).toBe("password reset for user");
    expect(line.password).toBe("[redacted]");
    expect(line.user).toBe("ann");
  });

  it("is total — does not throw on a cyclic structure", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
    const out = redact(cyclic) as Record<string, unknown>;
    expect(out.a).toBe(1);
    expect(out.self).toBe("[circular]");
  });

  it("passes primitives and null through unchanged", () => {
    expect(redact(42)).toBe(42);
    expect(redact("x")).toBe("x");
    expect(redact(null)).toBeNull();
  });
});

describe("serializeError", () => {
  it("captures name, message, and stack", () => {
    const out = serializeError(new TypeError("boom")) as Record<string, unknown>;
    expect(out.name).toBe("TypeError");
    expect(out.message).toBe("boom");
    expect(typeof out.stack).toBe("string");
  });

  it("recurses the cause chain", () => {
    const root = new Error("root");
    const wrapped = new Error("wrapped", { cause: root });
    const out = serializeError(wrapped) as Record<string, unknown>;
    expect(out.message).toBe("wrapped");
    expect((out.cause as Record<string, unknown>).message).toBe("root");
  });

  it("handles a non-Error thrown value", () => {
    expect(serializeError("just a string")).toEqual({ message: "just a string" });
    expect(serializeError(7)).toEqual({ message: "7" });
  });

  it("does not loop on a self-referential cause", () => {
    const err = new Error("loop") as Error & { cause?: unknown };
    err.cause = err;
    const out = serializeError(err) as Record<string, unknown>;
    expect(out.cause).toBe("[circular]");
  });
});

describe("durability and fallback", () => {
  it("does not throw when no session file is open", () => {
    closeLogger();
    expect(() => info("after close")).not.toThrow();
    // Reopen so afterEach has a file to clean up cleanly.
    initLogger(logsDir);
  });
});
