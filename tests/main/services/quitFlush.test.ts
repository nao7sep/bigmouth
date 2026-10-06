// The quit's post flush runs on a worker thread, and the quit waits for it for
// a bounded time only (unsaved-edits-conventions, Quitting). The wait is
// Atomics.wait's, which no fake clock reaches, so the bound is exercised with
// a short real one and workers whose outcome does not depend on time: one that
// answers at once, one that refuses at once, and one that never answers.

import { describe, expect, it } from "vitest";

import { flushPendingEditsWithin, runWorkerWithin } from "@main/core/services/quitFlush.js";

const worker = (name: string) => new URL(`./bounded-workers/${name}.ts`, import.meta.url);

describe("a worker run with a bound", () => {
  it("returns the worker's answer", () => {
    expect(runWorkerWithin(worker("answers"), { edits: 2 }, 10_000)).toEqual({ kind: "answered", value: { edits: 2 } });
  });

  it("reports a worker that says its work failed", () => {
    expect(runWorkerWithin(worker("refuses"), null, 10_000)).toEqual({
      kind: "crashed",
      error: "the storage root could not be used",
    });
  });

  it("gives up on a worker that does not answer once the bound has passed", () => {
    const started = performance.now();
    expect(runWorkerWithin(worker("stalls"), null, 100)).toEqual({ kind: "expired" });
    expect(performance.now() - started).toBeGreaterThanOrEqual(99);
  });

  it("reads a worker that cannot load as one that did not answer", () => {
    expect(runWorkerWithin(worker("missing"), null, 100)).toEqual({ kind: "expired" });
  });
});

describe("the quit's post flush", () => {
  it("starts no worker when nothing is buffered", () => {
    expect(flushPendingEditsWithin(0)).toEqual({ kind: "flushed", failures: [] });
  });
});
