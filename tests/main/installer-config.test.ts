import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { LANGUAGES } from "@shared/i18n/languages";

const config = parse(
  readFileSync(new URL("../../electron-builder.yml", import.meta.url), "utf8"),
) as {
  extraResources?: Array<{ from: string; to: string }>;
  files?: string[];
  nsis?: Record<string, unknown> & { installerLanguages?: string[] };
  mac?: { artifactName?: string; electronLanguages?: string[]; extendInfo?: Record<string, unknown> };
  dmg?: { artifactName?: string };
  win?: { artifactName?: string; electronLanguages?: string[] };
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

describe("packaged license texts", () => {
  it("ships the app, Electron, and Chromium licenses", () => {
    expect(config.extraResources).toEqual(expect.arrayContaining([
      { from: "LICENSE", to: "LICENSE.txt" },
      { from: "node_modules/electron/dist/LICENSE", to: "electron/LICENSE" },
      {
        from: "node_modules/electron/dist/LICENSES.chromium.html",
        to: "electron/LICENSES.chromium.html",
      },
    ]));
  });

  it("prepares Electron before every package-script builder invocation", () => {
    for (const script of Object.values(packageJson.scripts) as string[]) {
      if (script.includes("electron-builder")) {
        expect(script.indexOf("npm run prepare:electron")).toBeLessThan(
          script.indexOf("electron-builder"),
        );
      }
    }
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
    expect(config.nsis?.installerLanguages).toEqual([
      "en_US", "de_DE", "es_ES", "fr_FR", "it_IT", "pt_BR", "ru_RU", "ja_JP", "ko_KR", "zh_CN",
    ]);
  });
});
