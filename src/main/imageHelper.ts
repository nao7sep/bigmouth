import { configureImageConcurrency, generateDerivatives } from "./imageGeneration.js";
import type { ImageJob, ImageHelperReply } from "./imageHelperPool.js";

// Electron's utility-process port in production; Node IPC permits exercising
// this same entry in an ordinary headless process integration test.
const parent = process.parentPort;
const send = (reply: ImageHelperReply) => parent ? parent.postMessage(reply) : process.send?.(reply);
async function run(job: ImageJob): Promise<void> {
  configureImageConcurrency(job.threads);
  let lastProgress = -Infinity;
  const progress = () => {
    if (performance.now() - lastProgress < 250) return;
    lastProgress = performance.now();
    send({ type: "progress" });
  };
  const outcome = await generateDerivatives(job.sourcePath, job.expectedHash, job.dir, job.workspaceRoot, job.stageDirectory, progress,
    () => send({ type: "stage-created" }));
  // Wait for receipt before exiting, so a successful cache publication cannot
  // lose its result merely because the IPC send had not drained yet.
  if (parent) parent.once("message", () => process.exit(0));
  else process.once("message", () => process.disconnect?.());
  send({ type: "result", outcome: outcome.kind === "failed"
    ? { kind: "failed", error: outcome.error instanceof Error ? { name: outcome.error.name, message: outcome.error.message, stack: outcome.error.stack } : String(outcome.error) }
    : outcome });
}
if (parent) parent.once("message", (event) => { void run(event.data as ImageJob); });
else process.once("message", (job) => { void run(job as ImageJob); });
