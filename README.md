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

## Requirements

- macOS or Windows.
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

`npm run check` is the gate: it typechecks all three environments and runs the suite. The three `tsconfig.*.json` files split the environments — `node` (main + preload + shared), `web` (renderer + shared), and `test` (both).

Tests live under `tests/`, mirroring `src/` so each test's path names the file it covers. Two segments are elided consistently: `tests/main/…` covers `src/main/core/…`, and `tests/renderer/…` covers `src/renderer/src/…`. `tests/shared/` covers `src/shared/`. They run under Vitest in two projects — `main` on Node (which also runs `tests/shared`, since those modules must hold there) and `renderer` on jsdom. `npm run test:coverage` writes a report to the gitignored `coverage/`; it is not a gate and has no threshold.

## License

MIT © 2026 Yoshinao Inoguchi

## Contact

Yoshinao Inoguchi — yoshinao@inoguchi.com — <https://inoguchi.com>
