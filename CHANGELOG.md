# Changelog

All notable changes to grokscope.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-16

First public release.

### Added

- **Web dashboard** (Vite + Express + vanilla JS) reading local Grok session
  telemetry from `~/.grok/sessions/` and rendering live observability:
  - `/` Overview page with all-time aggregates across every session.
  - `/session.html?id=<id>` per-session detail page with live SSE updates.
- **Sidebar** with searchable session list, subagent nesting under parent
  sessions, expandable/collapsible subtrees, status badges, and live count.
- **Overview metrics**:
  - Primary metrics strip with 5 cards + sparklines (tokens, lines, tools,
    cost, sessions).
  - Secondary KPI strip (messages, turns, files, prompts, per-session averages).
  - 90-day activity heatmap, GitHub-style intensity grid.
  - Four time-series charts: sessions/day, lines/day, cumulative lines,
    cumulative cost.
  - Top projects with embedded progress bars.
  - Top sessions table (click-through to detail).
  - Tools histogram + lines-by-extension donut chart.
  - Recent sessions table at the bottom.
- **Session-detail metrics**:
  - Live SSE-driven metrics strip with 60-sample rolling sparklines.
  - 6 big cards (tokens, lines, files, turns, tools, API tokens).
  - Per-call usage chart (input vs output, cached input, reasoning portion,
    cost in USD), paginated.
  - Tool usage + lines-by-extension bars.
  - Recent edits + API captures, paginated.
  - Files in working directory, paginated, with size + mtime.
  - Git history with branch name + dirty count + last 30 commits, paginated.
  - Copy-to-clipboard button on the cwd path.
- **Backend API** (Node.js + Express, vanilla http otherwise):
  - `GET /api/health`
  - `GET /api/sessions`        full session list with parent / child relationships
  - `GET /api/session/:id`     per-session stats + usage block
  - `GET /api/session/:id/files`
  - `GET /api/session/:id/git`
  - `GET /api/active`          most-recently-active main session
  - `GET /api/overview`        all-time aggregates (60s cache)
  - `GET /api/usage`           per-call usage records from tap captures
  - `GET /api/captures`        recent tap index entries
  - `GET /api/stream`          Server-Sent Events stream of active stats (1Hz)
- **CLI tools** included in the repo:
  - `cli/grok-monitor` Python CLI dashboard.
  - `cli/grok-tap` Python logging reverse proxy for capturing per-call usage
    + cost from xAI's Responses API.
- **PM2 ecosystem config** (`ecosystem.config.cjs`) for running both backend
  and frontend as managed processes with auto-restart.
- **Vite multi-page config** (`vite.config.js`) with `/api` proxy and two
  HTML entry points.
- Keyboard shortcut: press `/` anywhere to focus the session-search input.

### Notes

- All data is read locally from `~/.grok/sessions/` and `~/.grok-tap/`. Nothing
  is uploaded anywhere. The dashboard binds to `127.0.0.1` only.
- Third-party tooling. Not affiliated with, endorsed by, or sponsored by
  xAI Corp.
- For per-API-call input/output token and cost data, run `cli/grok-tap` and
  add `base_url = "http://127.0.0.1:18080/v1"` under `[model.grok-build]` in
  `~/.grok/config.toml`.

[0.1.0]: https://github.com/daniel-farina/grokscope/releases/tag/v0.1.0
