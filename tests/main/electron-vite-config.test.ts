import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import config from "../../electron.vite.config";

describe("Electron development endpoint", () => {
  it("owns a stable strict loopback port", () => {
    expect(config.renderer?.server).toMatchObject({ host: "127.0.0.1", port: 26263, strictPort: true });
  });

  // run-dev checks that the endpoint is free before starting and waits for the
  // dev server on it, so each launcher keeps one copy of the host and port.
  it.each([
    ["run-dev.command", /^RENDERER_HOST="([^"]*)"\r?$/m, /^RENDERER_PORT="([^"]*)"\r?$/m],
    ["run-dev.ps1", /^\$rendererHost = "([^"]*)"\r?$/m, /^\$rendererPort = "([^"]*)"\r?$/m],
  ])("is the endpoint %s checks and waits for", (launcher, hostPattern, portPattern) => {
    const script = readFileSync(new URL(`../../scripts/${launcher}`, import.meta.url), "utf8");
    expect(hostPattern.exec(script)?.[1]).toBe(config.renderer?.server?.host);
    expect(Number(portPattern.exec(script)?.[1])).toBe(config.renderer?.server?.port);
  });
});
