import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type LockedPackage = { version?: string; resolved?: string; hasInstallScript?: boolean; link?: boolean };
type Packages = Record<string, LockedPackage>;
type Policy = Record<string, boolean>;

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  allowScripts: Policy;
};
const lockfile = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
  packages: Packages;
};

// npm trusts the registry tarball URL rather than the unpacked manifest's
// name/version. An exact approval cannot match when that URL is missing.
// This app reviews each version separately, including explicit denials.
function approvalProblems(policy: Policy, packages: Packages): string[] {
  const problems: string[] = [];
  const installed = new Set<string>();
  for (const [path, entry] of Object.entries(packages)) {
    const marker = path.lastIndexOf("node_modules/");
    if (marker < 0) continue;
    if (entry.link) {
      if (entry.hasInstallScript) problems.push(`${path}: unsupported linked script dependency`);
      continue;
    }
    if (!entry.version) {
      if (entry.hasInstallScript) problems.push(`${path}: missing locked version`);
      continue;
    }
    const name = path.slice(marker + "node_modules/".length);
    const identity = `${name}@${entry.version}`;
    installed.add(identity);
    if (!entry.hasInstallScript) continue;
    const basename = name.slice(name.lastIndexOf("/") + 1);
    let trusted = false;
    if (entry.resolved) {
      const url = new URL(entry.resolved);
      trusted = ["https:", "http:"].includes(url.protocol)
        && decodeURIComponent(url.pathname).endsWith(`/${name}/-/${basename}-${entry.version}.tgz`);
    }
    if (!trusted) problems.push(`${identity}: missing or inconsistent registry identity`);
    if (typeof policy[identity] !== "boolean") problems.push(`${identity}: missing decision`);
  }
  for (const [key, value] of Object.entries(policy)) {
    if (!installed.has(key)) problems.push(`${key}: not an exact installed identity`);
    if (typeof value !== "boolean") problems.push(`${key}: decision must be boolean`);
  }
  return problems;
}

const fixturePath = "node_modules/parent/node_modules/@scope/tool";
const fixturePackages = {
  [fixturePath]: {
    version: "1.2.3",
    resolved: "https://registry.npmjs.org/@scope/tool/-/tool-1.2.3.tgz",
    hasInstallScript: true,
  },
};
const fixturePolicy = { "@scope/tool@1.2.3": true };

describe("install-script approvals", () => {
  it("decides every locked script using an exact installed registry identity", () => {
    expect(approvalProblems(manifest.allowScripts, lockfile.packages)).toEqual([]);
  });

  it("supports scoped packages installed below another dependency", () => {
    expect(approvalProblems(fixturePolicy, fixturePackages)).toEqual([]);
  });

  it.each([
    { resolved: undefined },
    { resolved: "https://registry.npmjs.org/@scope/tool/-/tool-1.2.2.tgz" },
    { resolved: "https://registry.npmjs.org/another-package/-/another-package-1.2.3.tgz" },
  ])("rejects an approval whose lock source cannot prove its identity: $resolved", (change) => {
    const packages = { [fixturePath]: { ...fixturePackages[fixturePath], ...change } };
    expect(approvalProblems(fixturePolicy, packages)).toContain(
      "@scope/tool@1.2.3: missing or inconsistent registry identity",
    );
  });

  it.each(["@scope/tool", "@scope/tool@*", "@scope/tool@^1.2.3", "@scope/tool@1.2.2"])(
    "rejects a broad or stale decision: %s", (key) => {
      const policy: Policy = { ...fixturePolicy };
      delete policy["@scope/tool@1.2.3"];
      policy[key] = true;
      expect(approvalProblems(policy, fixturePackages)).toContain(`${key}: not an exact installed identity`);
      expect(approvalProblems(policy, fixturePackages)).toContain("@scope/tool@1.2.3: missing decision");
    },
  );
});
