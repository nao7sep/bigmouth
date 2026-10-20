import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// npm runs a dependency's install scripts only when package.json's allowScripts
// has an entry matching it, and otherwise skips them with nothing but a warning
// at the end of the install. A pin (`name@1.2.3`, or exact versions joined by
// `||`) matches only the version the lockfile resolves; npm ignores an entry
// written as a range. So a dependency update that leaves its pin behind, or a
// range written by hand, silently stops a script that the app needs.

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  allowScripts?: Record<string, boolean>;
};
const lockfile = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
  packages: Record<string, { version?: string; hasInstallScript?: boolean; link?: boolean }>;
};

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

type Entry = { key: string; name: string; versions: string[] | null };

function parseEntry(key: string): Entry {
  const at = key.lastIndexOf("@");
  if (at <= 0) return { key, name: key, versions: null };
  const spec = key.slice(at + 1).trim();
  const name = key.slice(0, at);
  if (spec === "" || spec === "*") return { key, name, versions: null };
  return { key, name, versions: spec.split("||").map((part) => part.trim()) };
}

/** Every installed copy of each package, by name, as the lockfile records it. */
const installed = new Map<string, Set<string>>();
const withInstallScripts: Array<{ name: string; version: string }> = [];
for (const [path, entry] of Object.entries(lockfile.packages)) {
  const marker = path.lastIndexOf("node_modules/");
  if (marker < 0 || !entry.version || entry.link) continue;
  const name = path.slice(marker + "node_modules/".length);
  if (!installed.has(name)) installed.set(name, new Set());
  installed.get(name)!.add(entry.version);
  if (entry.hasInstallScript) withInstallScripts.push({ name, version: entry.version });
}

const entries = Object.keys(manifest.allowScripts ?? {}).map(parseEntry);

describe("install-script approvals", () => {
  it("pins exact versions, never a range npm would ignore", () => {
    for (const entry of entries) {
      for (const version of entry.versions ?? []) {
        expect(version, entry.key).toMatch(EXACT_VERSION);
      }
    }
  });

  it("pins only versions the lockfile installs", () => {
    for (const entry of entries) {
      const versions = installed.get(entry.name);
      expect(versions, `${entry.key} names a package the lockfile does not install`).toBeDefined();
      for (const version of entry.versions ?? []) {
        expect(versions!.has(version), `${entry.key}: the lockfile installs ${[...versions!].join(", ")}`).toBe(true);
      }
    }
  });

  it("decides every locked package that has install scripts", () => {
    const undecided = withInstallScripts.filter(({ name, version }) => !entries.some(
      (entry) => entry.name === name && (entry.versions === null || entry.versions.includes(version)),
    ));
    expect(undecided.map(({ name, version }) => `${name}@${version}`)).toEqual([]);
  });
});
