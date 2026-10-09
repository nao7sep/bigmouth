import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

// The launcher helper is plain ESM because both shell families execute it directly.
// @ts-expect-error The directly executed .mjs helper intentionally has no declaration file.
import { claimRuntime, isRuntimeOwner, ownsProcess, releaseRuntime, REPO_ROOT } from "../../scripts/launcher-runtime.mjs";

describe("launcher process identity", () => {
  const identity = { kind: "electron", label: "BigMouth", executable: "BigMouth" };

  it("owns only this repository's Electron runtime", () => {
    expect(ownsProcess({
      pid: 10,
      parentPid: 1,
      executablePath: `${REPO_ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
      commandLine: "",
    }, identity)).toBe(true);
    expect(ownsProcess({
      pid: 11,
      parentPid: 1,
      executablePath: `${REPO_ROOT}/dist/mac-arm64/BigMouth.app/Contents/MacOS/BigMouth`,
      commandLine: "",
    }, identity)).toBe(true);
    expect(ownsProcess({
      pid: 12,
      parentPid: 1,
      executablePath: `${REPO_ROOT}\\dist\\win-unpacked\\BigMouth.exe`,
      commandLine: "",
    }, identity)).toBe(true);
    expect(ownsProcess({
      pid: 13,
      parentPid: 1,
      executablePath: "/another/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      commandLine: "",
    }, identity)).toBe(false);
  });

  it("does not let a stale launcher generation clean up its replacement", async () => {
    const first = `first-${randomUUID()}`;
    const second = `second-${randomUUID()}`;
    try {
      await claimRuntime(first);
      await claimRuntime(second);
      expect(await isRuntimeOwner(first)).toBe(false);
      expect(await isRuntimeOwner(second)).toBe(true);
    } finally {
      await releaseRuntime(second);
    }
  });
});

// The Windows paths list processes through PowerShell's Win32_Process and stop
// them with taskkill /T. Elsewhere the launcher takes its ps and signal paths,
// so these run on the Windows PC.
describe.runIf(process.platform === "win32")("launcher stop on Windows", () => {
  const identity = { kind: "electron", label: "BigMouth", executable: "BigMouth" };
  const helper = path.join(REPO_ROOT, "scripts", "launcher-runtime.mjs");
  const run = promisify(execFile);

  /** Processes the stop command would claim, read the way the launcher reads them. */
  async function ownedProcesses(): Promise<{ pid: number; commandLine: string }[]> {
    const { stdout } = await run("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
    ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const decoded = JSON.parse(stdout || "[]");
    return (Array.isArray(decoded) ? decoded : [decoded])
      .map((row) => ({
        pid: Number(row.ProcessId),
        parentPid: Number(row.ParentProcessId),
        executablePath: row.ExecutablePath ?? "",
        commandLine: row.CommandLine ?? "",
      }))
      .filter((item) => ownsProcess(item, identity));
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A node process carrying `marker` on its command line, with a child of its
   * own that carries nothing the launcher recognizes. Resolves once the child's
   * pid is known.
   */
  async function processTree(dir: string, marker: string): Promise<{ parent: ChildProcess; childPid: number }> {
    const script = path.join(dir, "tree.cjs");
    fs.writeFileSync(script, [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });',
      'process.stdout.write(`${child.pid}\\n`);',
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const parent = spawn(process.execPath, [script, marker], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    const childPid = await new Promise<number>((resolvePid, rejectPid) => {
      let output = "";
      parent.stdout!.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("\n")) resolvePid(Number(output.trim()));
      });
      parent.once("exit", () => rejectPid(new Error("The test process tree exited before it started.")));
    });
    return { parent, childPid };
  }

  it("reads processes with their executable paths", async () => {
    // wait-process finds a process by its executable path, read from Win32_Process.
    await expect(run(process.execPath, [helper, "wait-process", process.execPath, "15000"], { timeout: 30_000 }))
      .resolves.toBeDefined();
  }, 40_000);

  it("stops this folder's runtime with its whole tree, and nothing outside the folder", async () => {
    // A runtime the developer started from this folder would be stopped too.
    const running = await ownedProcesses();
    if (running.length > 0) {
      throw new Error(`Close BigMouth started from this folder before running this test (pid ${running.map((p) => p.pid).join(", ")}).`);
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-launcher-"));
    const ownMarker = path.join(REPO_ROOT, "node_modules", "electron", "dist", "windows-test-marker");
    const foreignMarker = path.join(dir, "elsewhere", "node_modules", "electron", "dist", "windows-test-marker");
    const own = await processTree(dir, ownMarker);
    const foreign = await processTree(dir, foreignMarker);
    try {
      const owned = await ownedProcesses();
      expect(owned.map((p) => p.pid)).toEqual([own.parent.pid]);

      // A windowless process ignores the plain taskkill /T, so this also takes
      // the forced /T /F path after the launcher's five-second wait.
      const { stdout } = await run(process.execPath, [helper, "stop", "electron", "BigMouth", "BigMouth"], {
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(stdout).toContain(`pid ${own.parent.pid}`);

      // taskkill /F returns as it asks for the kill, so the processes may take a moment to go.
      await vi.waitFor(() => {
        expect(alive(own.parent.pid!)).toBe(false);
        expect(alive(own.childPid)).toBe(false);
      }, { timeout: 5000 });
      expect(alive(foreign.parent.pid!)).toBe(true);
      expect(alive(foreign.childPid)).toBe(true);
    } finally {
      for (const pid of [own.parent.pid!, own.childPid, foreign.parent.pid!, foreign.childPid]) {
        await run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
