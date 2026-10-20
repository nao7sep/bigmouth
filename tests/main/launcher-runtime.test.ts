import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

// The launcher helper is plain ESM because both shell families execute it directly.
// @ts-expect-error The directly executed .mjs helper intentionally has no declaration file.
import { ownsProcess, parsePosixProcesses, REPO_ROOT } from "../../scripts/launcher-runtime.mjs";

describe("launcher process identity", () => {
  const appName = "BigMouth";

  it("owns only this repository's Electron runtime", () => {
    expect(ownsProcess({
      pid: 10,
      parentPid: 1,
      executablePath: `${REPO_ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
      commandLine: "",
    }, appName)).toBe(true);
    expect(ownsProcess({
      pid: 11,
      parentPid: 1,
      executablePath: `${REPO_ROOT}/dist/mac-arm64/BigMouth.app/Contents/MacOS/BigMouth`,
      commandLine: "",
    }, appName)).toBe(true);
    expect(ownsProcess({
      pid: 12,
      parentPid: 1,
      executablePath: `${REPO_ROOT}\\dist\\win-unpacked\\BigMouth.exe`,
      commandLine: "",
    }, appName)).toBe(true);
    expect(ownsProcess({
      pid: 13,
      parentPid: 1,
      executablePath: "/another/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      commandLine: "",
    }, appName)).toBe(false);
  });

  // macOS reads processes from `ps -axo pid=,ppid=,command=`: right-
  // aligned numbers and the whole command line, spaces included, with no
  // executable path of its own.
  it("reads ps output into processes and owns only this repository's Electron among them", () => {
    const electron = `${REPO_ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`;
    const stdout = [
      "    1     0 /sbin/launchd",
      `  812     1 ${electron} ${REPO_ROOT}`,
      `  813   812 ${electron.replace("/MacOS/Electron", "/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)")} --type=renderer`,
      "  900     1 /another/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /another/repo",
      "not a process line",
      "",
    ].join("\n");

    const processes = parsePosixProcesses(stdout);

    expect(processes).toEqual([
      { pid: 1, parentPid: 0, executablePath: "", commandLine: "/sbin/launchd" },
      { pid: 812, parentPid: 1, executablePath: "", commandLine: `${electron} ${REPO_ROOT}` },
      { pid: 813, parentPid: 812, executablePath: "", commandLine: expect.stringContaining("Electron Helper (Renderer).app") },
      { pid: 900, parentPid: 1, executablePath: "", commandLine: "/another/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /another/repo" },
    ]);
    expect(processes.filter((item: { pid: number; parentPid: number; executablePath: string; commandLine: string }) => ownsProcess(item, appName)).map((item: { pid: number }) => item.pid))
      .toEqual([812, 813]);
  });

  it.each(["success", "assertion failure", "partial setup"])("isolates ownership and stale generations after %s", async (outcome) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-launcher-owner-"));
    const scripts = path.join(root, "fixture", "scripts");
    fs.mkdirSync(scripts, { recursive: true });
    const helper = path.join(scripts, "launcher-runtime.mjs");
    fs.copyFileSync(path.join(REPO_ROOT, "scripts", "launcher-runtime.mjs"), helper);
    const sentinel = path.join(root, `company-launcher-${createHash("sha256").update(REPO_ROOT).digest("hex").slice(0, 20)}.owner`);
    fs.writeFileSync(sentinel, "existing-launcher\n");
    const script = [
      'import { pathToFileURL } from "node:url";',
      'import assert from "node:assert/strict";',
      'const [helper, outcome] = process.argv.slice(1);',
      'const { claimRuntime, isRuntimeOwner, releaseRuntime } = await import(pathToFileURL(helper).href);',
      'try {',
      '  await claimRuntime("first");',
      '  if (outcome === "partial setup") throw new Error("simulated failure");',
      '  await claimRuntime("second");',
      '  assert.equal(await isRuntimeOwner("first"), false);',
      '  assert.equal(await isRuntimeOwner("second"), true);',
      '  if (outcome === "assertion failure") throw new Error("simulated failure");',
      '} catch (error) {',
      '  if (error.message !== "simulated failure") throw error;',
      '} finally {',
      '  await releaseRuntime("first");',
      '  await releaseRuntime("second");',
      '}',
    ].join("\n");
    try {
      await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script, helper, outcome], {
        env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
      });
      expect(fs.readFileSync(sentinel, "utf8")).toBe("existing-launcher\n");
      expect(fs.readdirSync(root).sort()).toEqual([path.basename(sentinel), "fixture"].sort());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// The Windows paths list processes through PowerShell's Win32_Process and stop
// them with taskkill /T. On macOS the launcher takes its ps and signal paths,
// so these run on the Windows PC.
describe.runIf(process.platform === "win32")("launcher stop on Windows", () => {
  const appName = "BigMouth";
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
      .filter((item) => ownsProcess(item, appName));
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
  async function processTree(dir: string, marker: string, cleanupPids: number[]): Promise<{ parent: ChildProcess; childPid: number }> {
    const script = path.join(dir, "tree.cjs");
    fs.writeFileSync(script, [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });',
      'process.stdout.write(`${child.pid}\\n`);',
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const parent = spawn(process.execPath, [script, marker], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    if (parent.pid) cleanupPids.push(parent.pid);
    const childPid = await new Promise<number>((resolvePid, rejectPid) => {
      let output = "";
      parent.stdout!.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("\n")) {
          const pid = Number(output.trim());
          cleanupPids.push(pid);
          resolvePid(pid);
        }
      });
      parent.once("error", rejectPid);
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
    const cleanupPids: number[] = [];
    try {
      const own = await processTree(dir, ownMarker, cleanupPids);
      const foreign = await processTree(dir, foreignMarker, cleanupPids);
      const owned = await ownedProcesses();
      expect(owned.map((p) => p.pid)).toEqual([own.parent.pid]);

      // A windowless process ignores the plain taskkill /T, so this also takes
      // the forced /T /F path after the launcher's five-second wait.
      const { stdout } = await run(process.execPath, [helper, "stop", "BigMouth"], {
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
      for (const pid of cleanupPids) {
        await run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
      }
      await vi.waitFor(() => expect(cleanupPids.filter(alive)).toEqual([]));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

// On macOS the launcher lists processes with ps and stops them with SIGTERM,
// then SIGKILL for whatever is left after its five-second wait. Signals are what
// differ from Windows, so this runs everywhere but there. The helper is copied
// into a disposable folder, which becomes its repository root: only processes
// started under that folder are its own, so a BigMouth the developer is running
// from this checkout is never stopped.
describe.runIf(process.platform !== "win32")("launcher stop on macOS", () => {
  const run = promisify(execFile);

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A node process carrying `marker` on its command line, which records a
   * SIGTERM in `termLog` and stays alive through it, with a child of its own
   * that carries nothing the launcher recognizes and ends on SIGTERM. Resolves
   * once the child's pid is known.
   */
  async function processTree(script: string, marker: string, termLog: string, cleanupPids: number[]): Promise<{ parent: ChildProcess; childPid: number }> {
    const parent = spawn(process.execPath, [script, marker, termLog], { stdio: ["ignore", "pipe", "inherit"] });
    if (parent.pid) cleanupPids.push(parent.pid);
    const childPid = await new Promise<number>((resolvePid, rejectPid) => {
      let output = "";
      parent.stdout!.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("\n")) {
          const pid = Number(output.trim());
          cleanupPids.push(pid);
          resolvePid(pid);
        }
      });
      parent.once("error", rejectPid);
      parent.once("exit", () => rejectPid(new Error("The test process tree exited before it started.")));
    });
    return { parent, childPid };
  }

  it("stops the folder's runtime and its tree with SIGTERM, then SIGKILL, and nothing outside the folder", async () => {
    // ps reports the resolved path the helper's own REPO_ROOT is built from.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-launcher-posix-")));
    const repo = path.join(root, "fixture");
    const helper = path.join(repo, "scripts", "launcher-runtime.mjs");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, "scripts", "launcher-runtime.mjs"), helper);
    const script = path.join(root, "tree.cjs");
    fs.writeFileSync(script, [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      'const termLog = process.argv[3];',
      'process.on("SIGTERM", () => fs.appendFileSync(termLog, "SIGTERM\\n"));',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'process.stdout.write(`${child.pid}\\n`);',
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const ownMarker = path.join(repo, "node_modules", "electron", "dist", "posix-test-marker");
    const foreignMarker = path.join(root, "elsewhere", "node_modules", "electron", "dist", "posix-test-marker");
    const ownTerms = path.join(root, "own-terms.log");
    const foreignTerms = path.join(root, "foreign-terms.log");
    const cleanupPids: number[] = [];
    try {
      const own = await processTree(script, ownMarker, ownTerms, cleanupPids);
      const foreign = await processTree(script, foreignMarker, foreignTerms, cleanupPids);

      const { stdout } = await run(process.execPath, [helper, "stop", "BigMouth"], {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, TMPDIR: root },
      });
      expect(stdout).toContain(`pid ${own.parent.pid}`);
      expect(stdout).not.toContain(String(foreign.parent.pid));

      // The parent was asked first and declined; SIGKILL ended it. A killed
      // process can linger until its parent reaps it, so wait for both to go.
      expect(fs.readFileSync(ownTerms, "utf8")).toBe("SIGTERM\n");
      await vi.waitFor(() => {
        expect(alive(own.parent.pid!)).toBe(false);
        expect(alive(own.childPid)).toBe(false);
      }, { timeout: 5000 });
      expect(fs.existsSync(foreignTerms)).toBe(false);
      expect(alive(foreign.parent.pid!)).toBe(true);
      expect(alive(foreign.childPid)).toBe(true);
    } finally {
      for (const pid of cleanupPids) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      await vi.waitFor(() => expect(cleanupPids.filter(alive)).toEqual([]));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});
