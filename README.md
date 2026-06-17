# BigMouth

BigMouth is a local-first writing preflight tool for composing and reviewing blog posts and social-media content before you publish. You write in Markdown, run AI-powered quality and safety checks, generate metadata (title, slug, tags, SEO description), and export when ready — all on your own machine, with no sync, no cloud storage, and no direct publishing (you copy-paste to your platform of choice). It's a single-user desktop-style web app (Node.js backend + React frontend) for writers who want a deliberate Draft → Checked → Published lane and a Claude-backed review before anything goes out.

## Features

- **Workspaces** — multiple isolated workspaces (posts, assets, settings, AI config), each pointable at any directory for easy git versioning
- **Markdown editor** with autosave and a three-stage Draft → Checked → Published workflow; published posts are locked
- **AI analysis** — run named prompts against a draft to catch issues before publishing, streamed as the model responds
- **AI metadata & imaging** — generate title/slug/tags/SEO description, and temporary English image-prompt variants
- **Assets** — per-post image and file uploads, embedded directly in the editor
- **Multi-language** — write in any language; generate English supplement fields for non-English posts
- **Diff-friendly storage** — one Markdown file per post with a fixed name, so edits and status changes read as clean in-place git diffs

## Requirements

- Node.js 20.19+ and npm
- A Claude (Anthropic) API key for the AI features (analysis, metadata, imaging)
- Single-user with **no authentication** — loopback-only by default; exposing it to a trusted LAN is opt-in via config

## Getting started

Double-click the launcher for your platform (`scripts/run-dev.command` on macOS, `scripts/run-dev.ps1` on Windows), or run from source:

```sh
npm install
npm run dev
```

The server starts on `http://localhost:3141`. Open it and create a workspace to begin.

## License

MIT © 2026 Yoshinao Inoguchi

## Contact

Yoshinao Inoguchi — nao7sep@gmail.com
