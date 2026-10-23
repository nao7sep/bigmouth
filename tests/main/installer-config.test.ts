import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { JSDOM } from "jsdom";
import { APP_NAME } from "@shared/appName";
import { LANGUAGES } from "@shared/i18n/languages";

const config = parse(
  readFileSync(new URL("../../electron-builder.yml", import.meta.url), "utf8"),
) as {
  extraResources?: Array<{ from: string; to: string }>;
  asarUnpack?: string[];
  files?: string[];
  nsis?: Record<string, unknown> & { installerLanguages?: string[] };
  mac?: { target?: Array<string | { target: string }>; artifactName?: string; electronLanguages?: string[]; extendInfo?: Record<string, unknown> };
  dmg?: { artifactName?: string };
  win?: { target?: Array<string | { target: string }>; artifactName?: string; electronLanguages?: string[] };
  productName?: string;
  directories?: { output?: string };
};
const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

describe("packaged development metadata", () => {
  it("excludes source maps and TypeScript declarations", () => {
    expect(config.files).toEqual(expect.arrayContaining([
      "!**/*.map",
      "!**/*.d.ts",
      "!**/*.d.mts",
      "!**/*.d.cts",
    ]));
  });
});

describe("packaged native modules", () => {
  // sharp's binding and libvips are loaded by the OS from real files, which
  // cannot be inside app.asar.
  it("unpacks sharp and its platform binaries from the archive", () => {
    expect(packageJson.dependencies.sharp).toBeDefined();
    expect(config.asarUnpack).toEqual(expect.arrayContaining(["node_modules/sharp/**", "node_modules/@img/**"]));
  });
});

describe("packaged licence", () => {
  it("ships the app's licence", () => {
    expect(config.extraResources).toEqual(expect.arrayContaining([{ from: "LICENSE", to: "LICENSE.txt" }]));
  });
});

describe("Windows installer configuration", () => {
  it("uses the assisted dual-scope NSIS contract", () => {
    expect(config.nsis).toMatchObject({
      oneClick: false,
      perMachine: false,
      allowElevation: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      runAfterFinish: true,
    });
  });
});

// app-release-conventions: <app>-<version>.dmg, <app>-<version>-setup.exe,
// <app>-<version>-mac.zip / -win.zip. electron-builder's defaults add the arch
// for anything but x64, so every shipped name is set explicitly.
describe("release artifact names", () => {
  it("names every shipped artifact by the release contract", () => {
    expect(config.dmg?.artifactName).toBe("${productName}-${version}.${ext}");
    expect(config.mac?.artifactName).toBe("${productName}-${version}-mac.${ext}");
    expect(config.nsis?.artifactName).toBe("${productName}-${version}-setup.${ext}");
    expect(config.win?.artifactName).toBe("${productName}-${version}-win.${ext}");
  });
});

// localization-conventions: the bundle declares exactly the interface
// languages, and every platform surface outside the window follows them.
describe("interface languages outside the window", () => {
  it("declares exactly the set in the macOS bundle", () => {
    expect(config.mac?.extendInfo?.CFBundleLocalizations).toEqual([...LANGUAGES]);
  });

  it("keeps Electron's locale resources for the set only, named as each platform names them", () => {
    const macNames = LANGUAGES.map((tag) => ({ "pt-BR": "pt_BR", "zh-Hans": "zh_CN" })[tag as string] ?? tag);
    const winNames = LANGUAGES.map((tag) => ({ en: "en-US", "zh-Hans": "zh-CN" })[tag as string] ?? tag);
    expect(config.mac?.electronLanguages).toEqual(macNames);
    expect(config.win?.electronLanguages).toEqual(winNames);
  });

  it("builds the Windows installer in the set, with English first as the fallback", () => {
    const nsisNames = LANGUAGES.map((tag) => ({
      en: "en_US", de: "de_DE", es: "es_ES", fr: "fr_FR", it: "it_IT", "pt-BR": "pt_BR",
      ru: "ru_RU", ja: "ja_JP", ko: "ko_KR", "zh-Hans": "zh_CN",
    })[tag as string]);
    expect(LANGUAGES[0]).toBe("en");
    expect(config.nsis?.installerLanguages).toEqual(nsisNames);
  });
});

// rebuild and run-built find the packaged app under the packaging output by its
// product name, and the launcher helper recognizes its running processes by the
// same name, so each launcher keeps one copy of both.
// The packaged app's name comes from productName, which cannot import the
// name the app uses for itself, so the two are compared here.
describe("the app's name", () => {
  it("names the packaged app as the app names itself", () => {
    expect(config.productName).toBe(APP_NAME);
  });

  it("titles the main window's page with it", () => {
    const html = readFileSync(new URL("../../src/renderer/index.html", import.meta.url), "utf8");
    expect(new JSDOM(html).window.document.title).toBe(APP_NAME);
  });
});

describe("packaged app the launchers look for", () => {
  it.each([
    ["rebuild.command", /^APP_NAME="([^"]*)"\r?$/m, /^OUT_DIR="([^"]*)"\r?$/m],
    ["run-built.command", /^APP_NAME="([^"]*)"\r?$/m, /^OUT_DIR="([^"]*)"\r?$/m],
    ["run-dev.command", /^APP_NAME="([^"]*)"\r?$/m, null],
    ["rebuild.ps1", /^\$appName = "([^"]*)"\r?$/m, /^\$outDir = "([^"]*)"\r?$/m],
    ["run-built.ps1", /^\$appName = "([^"]*)"\r?$/m, /^\$outDir = "([^"]*)"\r?$/m],
    ["run-dev.ps1", /^\$appName = "([^"]*)"\r?$/m, null],
  ])("is the one %s names", (launcher, namePattern, outputPattern) => {
    const script = readFileSync(new URL(`../../scripts/${launcher}`, import.meta.url), "utf8");
    expect(namePattern.exec(script)?.[1]).toBe(config.productName);
    if (outputPattern) expect(outputPattern.exec(script)?.[1]).toBe(config.directories?.output);
  });
});

describe("release workflow inputs", () => {
  it("keeps the lockfile root's runtime requirement aligned with the manifest", () => {
    const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
    expect(lock.packages[""].engines).toEqual(packageJson.engines);
  });

  it("requires exactly the artifacts built by each runner's platform", () => {
    const workflow = parse(readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8")) as {
      jobs: { build: {
        strategy: { matrix: { include: Array<{ os: string; artifacts: string }> } };
        steps: Array<{ uses?: string; with?: Record<string, unknown> }>;
      } };
    };
    const build = workflow.jobs.build;
    const platforms = new Map([
      ["macos-latest", config.mac],
      ["windows-latest", config.win],
    ]);
    const runners = build.strategy.matrix.include;
    expect(runners.map(({ os }) => os).sort()).toEqual([...platforms.keys()].sort());
    for (const { os, artifacts } of runners) {
      const platform = platforms.get(os);
      expect(platform?.target).toBeDefined();
      const extensions = platform!.target!.map((target) => {
        const name = typeof target === "string" ? target : target.target;
        return name === "nsis" ? "exe" : name;
      });
      expect(artifacts.trim().split(/\s+/).sort()).toEqual(
        extensions.map((ext) => `${config.directories?.output}/*.${ext}`).sort(),
      );
    }
    const attachment = build.steps.find(({ uses }) => uses?.startsWith("softprops/action-gh-release@"));
    expect(attachment?.with?.files).toBe("${{ matrix.artifacts }}");
    expect(attachment?.with?.fail_on_unmatched_files).toBe(true);
  });
});
