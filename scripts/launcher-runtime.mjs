// launcher-runtime: the helper the run-dev, run-built and rebuild launchers of
// both platforms call as `node launcher-runtime.mjs <command> [args]`. One app
// runtime per repository: the launcher that starts the app records its process
// ID and executable under .git; the next launcher asks that process to quit only
// while it still runs that executable, and stops with a message rather than
// force-closing it when it stays open. The app started any other way is left to
// its single-instance behavior, which brings its window forward instead.
//
// Commands (<name> is the app's name, used in messages):
//   stop <name>                               ask the recorded runtime to quit
//   stop-if-recorded <pid> <name>             the same, only while <pid> is the recorded one
//   launch-bundle <app bundle> <name>         open a new instance (macOS) and record it
//   launch-exe <executable> <name>            start the executable (Windows) and record it
//   record-wrapped <pid> <executable> <name>  record the app process a wrapper started; prints its pid
//   prepare-candidate <output>                remove the build output and any earlier candidate; print the candidate folder
//   publish-candidate <output> <name>         replace the packaged app in <output> with the validated candidate
//   check-endpoint <host> <port>              fail when the port is taken
//   wait-http <url> [timeout-ms]              wait until the URL responds

import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECORD_FILE = join(REPO_ROOT, ".git", "launcher-runtime-process");
const windows = process.platform === "win32";

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function powershell(script) {
  const { stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

async function osascript(script, ...args) {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, ...args], { encoding: "utf8" });
  return stdout.trim();
}

function sameExecutable(left, right) {
  return windows ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** The executable a process runs, or "" when no such process exists. */
async function executableOf(pid) {
  if (windows) return powershell(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`);
  // ps shows the path a process was started with, which a wrapper can give relatively; lsof names the file it runs.
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], { encoding: "utf8" });
    return stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? "";
  } catch (error) {
    if (error?.code === 1) return ""; // lsof lists nothing for an ended process
    throw error;
  }
}

async function record(pid, executable) {
  await writeFile(RECORD_FILE, `${pid}\n${executable}\n`, "utf8");
}

/** The recorded process ID, returned only while that process still runs the recorded executable. */
async function recordedPid() {
  let text;
  try {
    text = await readFile(RECORD_FILE, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  const [pidText, executable] = text.split(/\r?\n/);
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0 || !executable) return undefined;
  return sameExecutable(await executableOf(pid), executable) ? pid : undefined;
}

/** Ask the process to quit as a user would, so it can still save or ask about running work. */
async function requestClose(pid) {
  if (windows) {
    await powershell(`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $null = $p.CloseMainWindow() }`);
    return;
  }
  await osascript(`ObjC.import('AppKit');
function run(args) {
  var application = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(args[0]));
  if (application) application.terminate;
}`, String(pid));
}

async function stopRecorded(appName, onlyPid) {
  const pid = await recordedPid();
  if (pid === undefined || (onlyPid !== undefined && pid !== onlyPid)) return;
  process.stdout.write(`Asking the running ${appName} (pid ${pid}) to quit.\n`);
  await requestClose(pid);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await recordedPid() !== pid) return;
    await delay(100);
  }
  throw new Error(`${appName} is still open, perhaps saving or asking about running work. Close it, then run this launcher again.`);
}

const singleInstanceNote = (appName) => `If ${appName} was already running outside these launchers, its window is brought forward instead.\n`;

/** Open a new instance of the bundle through Launch Services, which gives it its bundle identity. */
async function launchBundle(bundle, appName) {
  const pid = Number(await osascript(`ObjC.import('AppKit');
function run(args) {
  var application = $.NSWorkspace.sharedWorkspace.launchApplicationAtURLOptionsConfigurationError(
    $.NSURL.fileURLWithPath(args[0]), $.NSWorkspaceLaunchNewInstance, $({}), null);
  return application.isNil() ? '' : String(application.processIdentifier);
}`, resolve(bundle)));
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`${appName} could not be opened.`);
  await record(pid, await executableOf(pid));
  process.stdout.write(singleInstanceNote(appName));
}

async function launchExecutable(executable, appName) {
  const child = spawn(resolve(executable), [], { detached: true, stdio: "ignore" });
  await once(child, "spawn");
  child.unref();
  await record(child.pid, resolve(executable));
  process.stdout.write(singleInstanceNote(appName));
}

// rebuild packages into `<output>.candidate` and publishes it over the output only once it is
// complete, so the previous runnable package survives a failed build.
const candidateOf = (output) => resolve(REPO_ROOT, `${output}.candidate`);
const previousOf = (output) => resolve(REPO_ROOT, `${output}.previous`);

/** The packaged executable under `folder`: inside the .app bundle on macOS, the unpacked .exe on Windows. */
function packagedExecutable(folder, appName) {
  if (windows) return join(folder, "win-unpacked", `${appName}.exe`);
  if (!existsSync(folder)) return null;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const executable = join(folder, entry.name, `${appName}.app`, "Contents", "MacOS", appName);
      if (existsSync(executable)) return executable;
    }
  }
  return null;
}

async function prepareCandidate(output) {
  await rm(join(REPO_ROOT, "out"), { recursive: true, force: true });
  await rm(candidateOf(output), { recursive: true, force: true });
  process.stdout.write(`${candidateOf(output)}\n`);
}

/** Swap the validated candidate in for the packaged output, restoring the previous one if the swap fails. */
async function publishCandidate(output, appName) {
  const target = resolve(REPO_ROOT, output);
  const candidate = candidateOf(output);
  const previous = previousOf(output);
  const executable = packagedExecutable(candidate, appName);
  if (!executable || !(await stat(executable).catch(() => null))?.isFile()) {
    throw new Error(`Packaging did not produce a runnable ${appName} under ${candidate}.`);
  }
  await rm(previous, { recursive: true, force: true });
  let movedPrevious = false;
  try {
    await rename(target, previous);
    movedPrevious = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await rename(candidate, target);
  } catch (error) {
    if (movedPrevious) await rename(previous, target);
    throw error;
  }
  if (movedPrevious) {
    await rm(previous, { recursive: true, force: true }).catch((error) => {
      process.stderr.write(`The new package is ready; the previous one could not be removed from ${previous}: ${error.message}\n`);
    });
  }
}

async function listProcesses() {
  if (!windows) {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    return stdout.split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
      .map((match) => ({ pid: Number(match[1]), parentPid: Number(match[2]), executable: match[3].trim() }));
  }
  const decoded = JSON.parse(await powershell(
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress",
  ) || "[]");
  return (Array.isArray(decoded) ? decoded : [decoded]).map((row) => ({
    pid: Number(row.ProcessId),
    parentPid: Number(row.ParentProcessId),
    executable: row.ExecutablePath ?? "",
  }));
}

/**
 * Record the app process that the wrapper (npm run dev, then electron-vite)
 * starts, once it appears: the topmost descendant running the executable, since
 * Electron's own child processes can share it. Fails when the wrapper ends
 * first, as it does when the build fails.
 */
async function recordWrapped(wrapperPid, executable, appName) {
  const expected = resolve(executable);
  for (;;) {
    const processes = await listProcesses();
    if (!processes.some((item) => item.pid === wrapperPid)) {
      throw new Error(`The ${appName} development runtime ended before the app started.`);
    }
    const descendants = new Set([wrapperPid]);
    for (let grown = true; grown;) {
      grown = false;
      for (const item of processes) {
        if (descendants.has(item.parentPid) && !descendants.has(item.pid)) {
          descendants.add(item.pid);
          grown = true;
        }
      }
    }
    const candidates = processes.filter((item) => item.pid !== wrapperPid && descendants.has(item.pid)
      && sameExecutable(basename(item.executable), basename(expected)));
    const matches = [];
    for (const item of candidates) {
      const running = windows ? item.executable : await executableOf(item.pid);
      if (sameExecutable(running, expected)) matches.push({ ...item, executable: running });
    }
    const app = matches.find((item) => !matches.some((other) => other.pid === item.parentPid));
    if (app) {
      await record(app.pid, app.executable);
      process.stdout.write(`${app.pid}\n`);
      return;
    }
    await delay(200);
  }
}

async function assertEndpointAvailable(host, port) {
  await new Promise((resolveProbe, rejectProbe) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (error) => {
      rejectProbe(new Error(
        `Cannot bind ${host}:${port}: ${error.code ?? error.message}. The listener was left running because its app identity is unknown.`,
      ));
    });
    probe.listen({ host, port, exclusive: true }, () => {
      probe.close((error) => error ? rejectProbe(error) : resolveProbe());
    });
  });
}

async function waitForHttp(url, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(`${url} did not become ready within ${timeoutMilliseconds} ms (${lastError}).`);
}

async function main([command, ...args]) {
  if (command === "stop") {
    if (!args[0]) throw new Error("Expected stop <name>.");
    return stopRecorded(args[0]);
  }
  if (command === "stop-if-recorded") {
    const pid = Number(args[0]);
    if (!Number.isInteger(pid) || !args[1]) throw new Error("Expected stop-if-recorded <pid> <name>.");
    return stopRecorded(args[1], pid);
  }
  if (command === "launch-bundle") {
    if (!args[0] || !args[1]) throw new Error("Expected launch-bundle <app bundle> <name>.");
    return launchBundle(args[0], args[1]);
  }
  if (command === "launch-exe") {
    if (!args[0] || !args[1]) throw new Error("Expected launch-exe <executable> <name>.");
    return launchExecutable(args[0], args[1]);
  }
  if (command === "record-wrapped") {
    const pid = Number(args[0]);
    if (!Number.isInteger(pid) || !args[1] || !args[2]) throw new Error("Expected record-wrapped <pid> <executable> <name>.");
    return recordWrapped(pid, args[1], args[2]);
  }
  if (command === "prepare-candidate") {
    if (!args[0]) throw new Error("Expected prepare-candidate <output>.");
    return prepareCandidate(args[0]);
  }
  if (command === "publish-candidate") {
    if (!args[0] || !args[1]) throw new Error("Expected publish-candidate <output> <name>.");
    return publishCandidate(args[0], args[1]);
  }
  if (command === "check-endpoint") {
    const port = Number(args[1]);
    if (!args[0] || !Number.isInteger(port)) throw new Error("Expected check-endpoint <host> <port>.");
    return assertEndpointAvailable(args[0], port);
  }
  if (command === "wait-http") {
    const timeout = Number(args[1] ?? "60000");
    if (!args[0] || !Number.isFinite(timeout)) throw new Error("Expected wait-http <url> [timeout-ms].");
    return waitForHttp(args[0], timeout);
  }
  throw new Error("Expected one of: stop, stop-if-recorded, launch-bundle, launch-exe, record-wrapped, prepare-candidate, publish-candidate, check-endpoint, wait-http.");
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
