import { describe, it, expect } from "vitest";
import { isAllowedOrigin, DEV_ORIGINS } from "../../src/../src/shared/origin.js";

// The origin guard is the whole CSRF defense for an unauthenticated, possibly
// LAN-exposed server, so its policy is pinned here against regressions.
describe("isAllowedOrigin", () => {
  const PORT = 3141;
  const configured = ["https://writer.example.com"];

  it("allows the loopback host on the listening port", () => {
    expect(isAllowedOrigin(`http://127.0.0.1:${PORT}`, PORT, configured)).toBe(true);
    expect(isAllowedOrigin(`http://localhost:${PORT}`, PORT, configured)).toBe(true);
  });

  it("follows the configured port (a different port is not loopback-allowed)", () => {
    expect(isAllowedOrigin("http://127.0.0.1:9999", PORT, configured)).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1:9999", 9999, configured)).toBe(true);
  });

  it("allows the Vite dev origins", () => {
    for (const dev of DEV_ORIGINS) {
      expect(isAllowedOrigin(dev, PORT, configured)).toBe(true);
    }
  });

  it("allows operator-configured origins", () => {
    expect(isAllowedOrigin("https://writer.example.com", PORT, configured)).toBe(true);
  });

  it("rejects any other origin", () => {
    expect(isAllowedOrigin("https://evil.example.com", PORT, configured)).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1:5273.evil.com", PORT, configured)).toBe(false);
    // A different scheme to the same host/port is a different origin.
    expect(isAllowedOrigin(`https://127.0.0.1:${PORT}`, PORT, configured)).toBe(false);
  });

  it("rejects everything but loopback/dev when nothing is configured", () => {
    expect(isAllowedOrigin("https://writer.example.com", PORT, [])).toBe(false);
    expect(isAllowedOrigin(`http://localhost:${PORT}`, PORT, [])).toBe(true);
  });
});
