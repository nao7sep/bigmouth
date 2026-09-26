# BigMouth

BigMouth is a local-first **desktop app** for writers who want a deliberate, staged review before anything goes out. You draft blog posts and social-media content in Markdown, run Claude-backed quality and safety checks, generate metadata, and export when ready — all on your own machine, with no sync, no cloud storage, and no direct publishing (you copy-paste to the platform of your choice). Data lives in plain per-post Markdown files you can point at any folder and version with git. Single-user; the AI features are Claude (Anthropic) only, and the macOS build is Apple Silicon only.

## Features

- **Workspaces** — multiple isolated workspaces (posts, assets, settings, AI config). API keys are kept outside the workspace, so committing one never leaks a secret.
- **Markdown editor** with autosave and a Draft → Ready → Published → Expired lifecycle; published and expired posts are locked (move back to Draft or Ready to edit).
- **AI analysis** — run named prompts against a draft to catch issues before publishing, streamed as the model responds.
- **AI metadata & imaging** — generate title/slug/tags/SEO description, and temporary English image-prompt variants.
- **Assets** — per-post image and file uploads, embedded directly in the editor.
- **Multi-language** — write in any language; generate English supplement fields for non-English posts.
- **Diff-friendly storage** — one Markdown file per post with a fixed name, so edits and status changes read as clean in-place git diffs.
- **Light and dark themes** — follows the system by default; pick Light or Dark in Settings for every workspace at once.
- **Ten interface languages** — English, Deutsch, Español, Français, Italiano, Português, Русский, 日本語, 한국어 and 中文; follows the computer's language by default, or pick one in Settings. Dates follow the language, in each workspace's time zone: the computer's by default, or one chosen from the list.

## Requirements

- macOS 13 or later, or Windows.
- A Claude (Anthropic) API key for the AI features (analysis, metadata, imaging). Everything else works without one.
- Node.js 22.12+ and npm, to build or run from source.

## Download

Prebuilt installers and portable builds for macOS (Apple Silicon) and Windows are on the [Releases](https://github.com/nao7sep/bigmouth/releases/latest) page. These builds are **unsigned**, so the OS warns the first time you open one:

- **macOS** — right-click the app and choose **Open** (or run `xattr -dr com.apple.quarantine /Applications/BigMouth.app`).
- **Windows** — on the SmartScreen prompt, click **More info → Run anyway**.

## Run from source

Double-click the launcher for your platform — `scripts/run-dev.command` on macOS, `scripts/run-dev.ps1` on Windows — or run it by hand:

```sh
npm install
npm run dev
```

The Electron window opens; create a workspace to begin. `scripts/rebuild.command` / `.ps1` builds, packages and launches the app; `scripts/run-built.command` / `.ps1` relaunches the existing build without rebuilding.

## Development

`npm test` runs the same fixed set every time: the typecheck over all three environments, then the whole ordinary suite. `npm run test:full` is the gate at a batch's end and before a release: it runs that, and then the live lane, which sends a draft through the metadata, image-prompt, and analysis handlers to the real Anthropic API. Export `ANTHROPIC_API_KEY` first; the lane makes a few paid calls, and the full run fails without the key. The three `tsconfig.*.json` files split the environments — `node` (main + preload + shared), `web` (renderer + shared), and `test` (both).

Tests live under `tests/`, mirroring `src/` so each test's path names the file it covers. `tests/main/` mirrors `src/main/` with `core/` elided: `tests/main/services/…` covers `src/main/core/services/…` (likewise `ai/` and `shared/`), while `tests/main/ipc/…` and top-level files such as `tests/main/window.test.ts` map directly to `src/main/`. `tests/renderer/…` covers `src/renderer/src/…`, `tests/shared/` covers `src/shared/`, and cross-cutting checks such as `tests/focus-rings.test.ts` and the localization gates in `tests/i18n/` sit at the top. `tests/live/` holds the paid live lane, which only `npm run test:full` runs. They run under Vitest in two projects — `main` on Node (which also runs `tests/shared`, since those modules must hold there) and `renderer` on jsdom. `npm run test:coverage` writes a report to the gitignored `coverage/`; it is not a gate and has no threshold.

## License

[GNU GPL v3 or later](LICENSE) © 2026 Yoshinao Inoguchi

## Contact

- **Name:** Yoshinao Inoguchi
- **GitHub:** [@nao7sep](https://github.com/nao7sep)
- **Email:** [yoshinao@inoguchi.com](mailto:yoshinao@inoguchi.com)
- **Website:** [inoguchi.com](https://inoguchi.com)
