// This qualifies the compiled helper's Node IPC path and real image decoding.
// Electron utilityProcess behavior remains a separate native-app boundary.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import sharp from "sharp";
import { build } from "vite";
import { expect, it, vi } from "vitest";
import { WORKER_ENTRIES } from "@main/builtEntries.js";
import { ImageHelperPool, type ImageJob, type ImageProcess } from "@main/imageHelperPool.js";
import { derivativeName, DISPLAY_EDGE, THUMB_EDGE } from "@main/imageGeneration.js";

class NodeImageProcess extends EventEmitter implements ImageProcess {
  readonly child: ChildProcess;
  readonly messages: (ImageJob | { type: "retire" })[] = [];
  readonly lifecycle: string[] = [];
  readonly exited: Promise<void>;
  didExit = false;
  stderr = "";
  constructor(entry: string, cwd: string) {
    super();
    this.child = fork(entry, [], { cwd, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    this.child.stderr?.on("data", (chunk: Buffer) => { this.stderr += chunk.toString(); });
    this.child.on("message", (reply) => {
      this.lifecycle.push(`received:${(reply as { type: string }).type}`);
      this.emit("message", reply);
    });
    this.child.on("error", (error) => this.emit("error", error));
    this.exited = new Promise((resolve) => this.child.once("exit", (code) => {
      this.didExit = true;
      this.lifecycle.push("exit");
      this.emit("exit", code ?? -1);
      resolve();
    }));
  }
  postMessage(job: ImageJob | { type: "retire" }): void {
    this.messages.push(job);
    this.lifecycle.push(`sent:${"type" in job ? job.type : "job"}`);
    this.child.send(job);
  }
  kill(): boolean { return this.child.kill("SIGTERM"); }
}

it("generates hash-named renditions in a compiled child, acknowledges retirement and cleans stages after exit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-image-helper-"));
  const children: NodeImageProcess[] = [];
  let pool: ImageHelperPool | undefined;
  let cleaned = false;
  try {
    const outDir = path.join(root, "helper");
    // Keep sharp external so the actual installed native library is loaded,
    // with module resolution rooted only in this fixture's temporary folder.
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    await build({
      configFile: false,
      logLevel: "silent",
      resolve: { alias: { "@shared": path.resolve("src/shared") } },
      ssr: { noExternal: true, external: ["sharp"] },
      build: {
        ssr: true, outDir, minify: false,
        rolldownOptions: {
          input: { [WORKER_ENTRIES.image]: path.resolve("src/main/imageHelper.ts") },
          output: { format: "cjs", entryFileNames: "[name].cjs" },
        },
      },
    });
    const workspace = path.join(root, "workspace");
    const cache = path.join(root, "cache");
    fs.mkdirSync(workspace);
    const source = path.join(workspace, "photo.jpg");
    const original = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#cc6633" } })
      .jpeg().withExif({ IFD0: { Make: "Camera", Model: "Private camera" } }).toBuffer();
    fs.writeFileSync(source, original);
    const hash = createHash("sha256").update(original).digest("hex");
    const cleanup = vi.fn(async (directory: string) => {
      // Cleanup owns only a stage this helper reported creating, after the
      // exact originating child has actually retired.
      expect(children).toHaveLength(1);
      expect(children[0].didExit).toBe(true);
      children[0].lifecycle.push("cleanup");
      expect(directory).toBe((children[0].messages[0] as ImageJob).stageDirectory);
      await fsp.rm(directory, { recursive: true, force: true });
      cleaned = true;
    });
    pool = new ImageHelperPool({ capacity: 2, cleanup, create: () => {
      const child = new NodeImageProcess(path.join(outDir, `${WORKER_ENTRIES.image}.cjs`), root);
      children.push(child);
      return child;
    } });
    const outcome = await pool.generate("workspace-id", source, hash, cache, workspace, true);
    expect(outcome, children[0]?.stderr).toEqual({ kind: "generated" });
    await vi.waitFor(() => expect(children[0].didExit).toBe(true), { timeout: 5000 });
    await children[0].exited;
    expect(children[0].child.exitCode).toBe(0);
    expect(children[0].child.signalCode).toBeNull();
    await vi.waitFor(() => expect(cleaned).toBe(true), { timeout: 5000 });
    expect(children[0].messages[1]).toEqual({ type: "retire" });
    const order = children[0].lifecycle;
    expect(order.indexOf("received:stage-created")).toBeLessThan(order.indexOf("received:result"));
    expect(order.indexOf("received:result")).toBeLessThan(order.indexOf("sent:retire"));
    expect(order.indexOf("sent:retire")).toBeLessThan(order.indexOf("exit"));
    expect(order.indexOf("exit")).toBeLessThan(order.indexOf("cleanup"));
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(cache).sort()).toEqual([derivativeName(hash, "display"), derivativeName(hash, "thumb")].sort());
    const display = await sharp(path.join(cache, derivativeName(hash, "display"))).metadata();
    const thumb = await sharp(path.join(cache, derivativeName(hash, "thumb"))).metadata();
    expect([display.width, display.height, display.format]).toEqual([DISPLAY_EDGE, DISPLAY_EDGE / 2, "webp"]);
    expect([thumb.width, thumb.height, thumb.format]).toEqual([THUMB_EDGE, THUMB_EDGE / 2, "webp"]);
    expect(display.exif).toBeUndefined();
    expect(thumb.exif).toBeUndefined();
    expect(createHash("sha256").update(fs.readFileSync(source)).digest("hex")).toBe(hash);
    expect(fs.existsSync((children[0].messages[0] as ImageJob).stageDirectory)).toBe(false);
  } finally {
    pool?.stop();
    // Only children recorded by this fixture are eligible for termination.
    for (const child of children) if (!child.didExit) child.kill();
    await Promise.all(children.map(({ exited }) => exited));
    expect(children.every(({ didExit }) => didExit)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15000);
