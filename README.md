# BigMouth

BigMouth is a local-first **desktop app** (Electron — a React renderer over a Node main process) for writers who want a deliberate, staged review before anything goes out. You draft blog posts and social-media content in Markdown, run Claude-backed quality and safety checks, generate metadata, and export when ready — all on your own machine, with no sync, no cloud storage, and no direct publishing (you copy-paste to the platform of your choice). Data lives in plain per-post Markdown files you can point at any folder and version with git. Single-user, and in early development (0.x), so data formats and features may change without notice before 1.0.

## Features

- **Workspaces** — multiple isolated workspaces (posts, assets, settings, AI config), each pointable at any folder for easy git versioning. Your API key is stored separately under `~/.bigmouth` (or supplied via `ANTHROPIC_API_KEY`), never inside a workspace, so committing one never leaks a secret.
- **Markdown editor** with autosave and a Draft → Ready → Published → Expired lifecycle; published and expired posts are locked (move back to Draft or Ready to edit).
- **AI analysis** — run named prompts against a draft to catch issues before publishing, streamed as the model responds.
- **AI metadata & imaging** — generate title/slug/tags/SEO description, and temporary English image-prompt variants.
- **Assets** — per-post image and file uploads, embedded directly in the editor.
- **Multi-language** — write in any language; generate English supplement fields for non-English posts.
- **Diff-friendly storage** — one Markdown file per post with a fixed name, so edits and status changes read as clean in-place git diffs.

## Requirements

- macOS or Windows.
- A Claude (Anthropic) API key for the AI features (analysis, metadata, imaging). Everything else works without one.
- Node.js 22+ and npm, to build or run from source.

## Getting started

Double-click the launcher for your platform — `scripts/run-dev.command` on macOS, `scripts/run-dev.ps1` on Windows — or run from source:

```sh
npm install
npm run dev
```

The Electron window opens; create a workspace to begin. `scripts/rebuild` produces a packaged build and `scripts/run-built` launches it.

## License

MIT © 2026 Yoshinao Inoguchi

## Contact

Yoshinao Inoguchi — nao7sep@gmail.com
