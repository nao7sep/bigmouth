// Production worker mode, real fleet routing, and the central backup relay run
// together here. Every file and worker belongs to this one disposable fixture.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";
import { build } from "vite";
import { expect, it, vi } from "vitest";
import { WORKER_ENTRIES } from "@main/builtEntries.js";
import { createStorageFleet } from "@main/storageFleet.js";
import { StorageOwner, type StorageRequest, type WorkspaceContentSaveEvent } from "@main/storageOwner.js";
import type { StorageWorkerData } from "@main/storageWorker.js";
import { attachBackupRelay, stopBackups, useBackupRecorderModule } from "@main/core/services/backupStore.js";
import { initStorageRoot } from "@main/core/services/storagePaths.js";
import { defaultAnthropicSettings } from "@main/core/shared/defaults.js";

it("routes real workspace workers, copied post edits and credentials through their production owners", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-storage-fleet-"));
  const savedRoot = process.env.BIGMOUTH_DATA_DIR;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const ports: MessagePort[] = [];
  const origins: { workspace: boolean; worker: Worker; messages: unknown[] }[] = [];
  let fleet: ReturnType<typeof createStorageFleet> | undefined;
  try {
    process.env.BIGMOUTH_DATA_DIR = root;
    delete process.env.ANTHROPIC_API_KEY;
    initStorageRoot();
    const outDir = path.join(root, "worker");
    await build({
      configFile: false,
      logLevel: "silent",
      resolve: { alias: { "@shared": path.resolve("src/shared") } },
      ssr: { noExternal: true },
      build: {
        ssr: true,
        outDir,
        minify: false,
        rolldownOptions: {
          input: {
            [WORKER_ENTRIES.storage]: path.resolve("src/main/storageWorker.ts"),
            [WORKER_ENTRIES.backup]: path.resolve("src/main/core/services/backupWorker.ts"),
          },
          output: { format: "cjs", entryFileNames: "[name].js" },
        },
      },
    });
    const storageEntry = path.join(outDir, `${WORKER_ENTRIES.storage}.js`);
    useBackupRecorderModule(pathToFileURL(path.join(outDir, `${WORKER_ENTRIES.backup}.js`)));
    const logBudget = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(logBudget, 0, 8 * 1024 * 1024);
    fleet = createStorageFleet(StorageOwner, {
      capacity: 3,
      stopBackups,
      createOwner: (workspace) => new StorageOwner(() => {
        const { port1, port2 } = new MessageChannel();
        ports.push(port1);
        attachBackupRelay(port1);
        const workerData: StorageWorkerData = {
          workspace, backupPort: port2, logBudget,
          backupLimits: { bytes: 8 * 1024 * 1024, descriptors: 8 },
        };
        const worker = new Worker(storageEntry, {
          workerData, transferList: [port2], trackUnmanagedFds: false,
          env: { ...process.env, BIGMOUTH_DATA_DIR: root, ANTHROPIC_API_KEY: "" },
        });
        const origin = { workspace, worker, messages: [] as unknown[] };
        origins.push(origin);
        const send = worker.postMessage.bind(worker);
        vi.spyOn(worker, "postMessage").mockImplementation((value, transferList) => {
          origin.messages.push(value);
          send(value, transferList);
        });
        return worker;
      }, 8 * 1024 * 1024),
    });
    await fleet.run("initialize", [path.join(root, "Documents")]);
    const physicalParent = path.join(root, "workspaces");
    const aliasParent = path.join(root, "selected-workspaces");
    fs.mkdirSync(physicalParent);
    fs.symlinkSync(physicalParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
    const first = await fleet.run("createWorkspace", ["First", path.join(aliasParent, "first")]);
    const firstRoot = fs.realpathSync.native(first.dataDirectory);
    const targets = [{ name: "blog", defaultLanguage: "en", requiresMetadata: false }];
    await fleet.run("saveTargets", [first.dataDirectory, targets]);
    // A second spelling of the selected physical root must reuse its writer.
    await fleet.run("getSettings", [firstRoot]);
    const second = await fleet.run("createWorkspace", ["Second", path.join(physicalParent, "second")]);
    await fleet.run("saveTargets", [second.dataDirectory, targets]);
    const secondRoot = fs.realpathSync.native(second.dataDirectory);
    const registry = await fleet.run("listWorkspaces", []);
    expect(registry.map(({ id }) => id)).toEqual([first.id, second.id]);

    const post = await fleet.run("createPost", [first.dataDirectory, "blog", "en"]);
    const copiedFile = path.join(secondRoot, "posts", path.basename(post.filePath));
    fs.copyFileSync(post.filePath, copiedFile);
    await fleet.run("refreshIndex", [second.dataDirectory]);
    const id = post.frontMatter.id;
    const authored = new Date(new Date(post.frontMatter.createdAtUtc).getTime() + 1000);
    const events: WorkspaceContentSaveEvent[] = [];
    fleet.onContentSave((event) => events.push(event));
    await Promise.all([
      fleet.run("queueWorkspaceContent", [first.id, id, "First workspace authored body", authored]),
      fleet.run("queueWorkspaceMetadata", [first.id, id, { title: "First workspace title" }, authored]),
      fleet.run("queueWorkspaceContent", [second.id, id, "Second workspace authored body", authored]),
      fleet.run("queueWorkspaceMetadata", [second.id, id, { title: "Second workspace title" }, authored]),
    ]);
    expect(await fleet.flushAsync(5000)).toEqual({ kind: "flushed", failures: [] });
    await fleet.run("resumePendingFlushes", []);
    const firstBytes = fs.readFileSync(post.filePath, "utf8");
    const secondBytes = fs.readFileSync(copiedFile, "utf8");
    expect(firstBytes).toContain("First workspace authored body");
    expect(firstBytes).toContain("First workspace title");
    expect(firstBytes).not.toContain("Second workspace");
    expect(secondBytes).toContain("Second workspace authored body");
    expect(secondBytes).toContain("Second workspace title");
    expect(secondBytes).not.toContain("First workspace");
    expect(firstBytes).toContain(authored.toISOString());
    expect(secondBytes).toContain(authored.toISOString());
    expect(events.map(({ wsId, id: postId, kind }) => [wsId, postId, kind]).sort()).toEqual([
      [first.id, id, "saved"], [second.id, id, "saved"],
    ].sort());
    expect(await fleet.flushAsync(5000)).toEqual({ kind: "flushed", failures: [] });
    await fleet.run("resumePendingFlushes", []);
    expect(events).toHaveLength(2);
    expect(fs.readFileSync(post.filePath, "utf8")).toBe(firstBytes);
    expect(fs.readFileSync(copiedFile, "utf8")).toBe(secondBytes);

    await fleet.run("saveAnthropicSettings", [first, { ...defaultAnthropicSettings(), apiKey: "sk-fleet-local-secret" }]);
    expect((await fleet.run("getRoleCall", [first, "metadata"])).apiKey).toBe("sk-fleet-local-secret");
    expect((await fleet.run("getRoleCall", [second, "metadata"])).apiKey).toBeNull();
    const requests = (origin: typeof origins[number]) => origin.messages.filter((value): value is StorageRequest =>
      value !== null && typeof value === "object" && "name" in value);
    const local = origins.filter(({ workspace }) => !workspace);
    const workspace = origins.filter(({ workspace }) => workspace);
    expect(local).toHaveLength(1);
    expect(requests(local[0]).map(({ name }) => name)).toEqual(expect.arrayContaining([
      "initialize", "registerPreparedWorkspace", "saveAnthropicKey", "resolveAnthropicKey", "getAnthropicKeyState",
    ]));
    for (const origin of workspace) {
      const names = requests(origin).map(({ name }) => name);
      expect(names).not.toContain("initialize");
      expect(names).not.toContain("registerPreparedWorkspace");
      expect(names).not.toContain("saveAnthropicKey");
      expect(names).not.toContain("resolveAnthropicKey");
      expect(JSON.stringify(origin.messages)).not.toContain("sk-fleet-local-secret");
    }
    expect(workspace.flatMap(requests).map(({ name }) => name)).toEqual(expect.arrayContaining([
      "selectWorkspaceDirectory", "saveAnthropicConfig", "getRoleConfig",
    ]));
    expect(requests(local[0]).map(({ name }) => name)).not.toContain("saveAnthropicConfig");
    expect(requests(local[0]).map(({ name }) => name)).not.toContain("getRoleConfig");
    const firstWriter = workspace.filter((origin) => requests(origin).some((request) => request.name === "queueWorkspaceContent" && request.args[0] === first.id));
    expect(firstWriter).toHaveLength(1);
    expect(requests(firstWriter[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "prepareWorkspace" }),
      expect.objectContaining({ name: "getSettings", args: [firstRoot] }),
    ]));
    const contentRequests = workspace.flatMap(requests).filter(({ name }) => name === "queueWorkspaceContent");
    expect(contentRequests.map(({ args }) => args[0]).sort()).toEqual([first.id, second.id].sort());
    const metadataRequests = workspace.flatMap(requests).filter(({ name }) => name === "queueWorkspaceMetadata");
    expect(metadataRequests.map(({ args }) => args[0]).sort()).toEqual([first.id, second.id].sort());
    expect(fs.readFileSync(path.join(firstRoot, "config.json"), "utf8")).not.toContain("sk-fleet-local-secret");
    expect(await fleet.finishAsync(5000, 2000)).toBe(true);
    const backup = new DatabaseSync(path.join(root, "backups.sqlite3"), { readOnly: true });
    try {
      for (const [file, body] of [[post.filePath, "First workspace authored body"], [copiedFile, "Second workspace authored body"]]) {
        const row = backup.prepare("SELECT content FROM backups WHERE path = ? ORDER BY id DESC LIMIT 1").get(file) as { content: Uint8Array } | undefined;
        expect(row).toBeDefined();
        expect(Buffer.from(row!.content).toString("utf8")).toContain(body);
      }
    } finally { backup.close(); }
  } finally {
    await fleet?.stop();
    await stopBackups(0);
    for (const port of ports) port.close();
    if (savedRoot === undefined) delete process.env.BIGMOUTH_DATA_DIR;
    else process.env.BIGMOUTH_DATA_DIR = savedRoot;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    useBackupRecorderModule(new URL("../../src/main/core/services/backupWorker.ts", import.meta.url));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15000);
