# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Codex Deck is a full-stack TypeScript application providing a web UI for browsing and interacting with Codex CLI conversation history stored in `~/.codex/`. It supports both read-only history browsing and interactive Codex workflows (create threads, send messages, plan mode).

Remote-server adoption is staged. The `server/` and `wire/` workspace packages are the foundation for the future remote codex-deck `server`; use `docs/SERVER_IMPLEMENTATION.md` before making architectural changes there.

## Commands

Package manager is **pnpm**. Node.js 20+ required. This is a pnpm workspace: root `api/`+`web/` is the local app; `server/` and `wire/` are workspace packages.

### Root (local app)

- `pnpm dev` — run frontend (port 12000) + backend (port 12001) concurrently with watch mode
- `pnpm dev:web` — Vite dev server only (proxies `/api/*` to :12001)
- `pnpm dev:server` — backend only via `tsx watch api/index.ts --dev`
- `pnpm build` — production build (builds `wire` first, then server via tsup + web via Vite)
- `pnpm test` / `pnpm test:unit` — run the root unit test suite under `tests/unit/`
- `pnpm start` — run built CLI from `dist/index.js`
- `pnpm exec prettier --write .` — format before PRs

Run a single test file: `pnpm exec tsx --tsconfig tsconfig.test.json --test tests/unit/<file>.test.ts`

### Remote packages

- `pnpm --dir wire build` / `pnpm --dir wire test` — build/test the shared `@zuoyehaoduoa/wire` package
- `pnpm --dir server dev` — start the remote server with `.env` + `.env.dev`
- `pnpm --dir server build` — typecheck the remote server package
- `pnpm --dir server test` — run remote server tests
- `docker build -f Dockerfile.server .` — build the remote-server container image

### Per-surface test guidance

Run the tests that match the surface you changed:

- `api/` or `web/` changes → `pnpm test` and `pnpm build`
- `wire/` changes → `pnpm --dir wire test`
- `server/` changes → `pnpm --dir server test` and `pnpm --dir server build`
- Cross-cutting remote/auth changes → run all of the above

## Architecture

### Backend (`api/`)

Hono framework on Node.js HTTP server. Key modules:

- **`index.ts`** — CLI entry point (Commander.js). Parses `--port`, `--dir`, `--dev`, `--no-open`.
- **`server.ts`** — All Hono routes: session listing, conversation fetching, file diffs/tree/content, terminal runs, SSE streaming, and interactive Codex thread management. Also serves built frontend assets from `dist/web/`.
- **`storage.ts`** — Reads/parses Codex session data from `~/.codex/` (history.jsonl + per-session .jsonl files). Exports all shared TypeScript interfaces used by both backend and frontend.
- **`watcher.ts`** — Chokidar-based filesystem watcher with 20ms debounce. Monitors history.jsonl and sessions/ directory, fans out change events for SSE.
- **`codex-app-server.ts`** — Bridges web UI to `codex app-server` subprocess via RPC for interactive mode (create threads, send messages, interrupt, handle user-input prompts).
- **`path-utils.ts`** — Backend path normalization.

### Remote Server Adoption (`server/`, `wire/`)

- **`server/`** — Staged codex-deck remote server package and browser entrypoint for remote mode.
- **`wire/`** — Canonical shared protocol package for encrypted remote/server payloads, OPAQUE auth helpers, and session/update schemas.

Important: `server/` is not the current production backend for local codex-deck. It is a migration/adoption target. Prefer documenting and making deliberate architectural changes there rather than assuming it already matches codex-deck behavior.

When working inside `server/`, also read `server/CLAUDE.md` for package-specific guidance that applies to that subtree.

### Frontend (`web/`)

React 19 SPA built with Vite 6 + Tailwind CSS 4.

- **`app.tsx`** — Main orchestrator: three-pane layout (session list | conversation | diff/files), local/remote connection mode, message composer, model/plan mode selection, and live-update integration.
- **`components/`** — Session list, session view, diff pane, message block, markdown renderer, and `tool-renderers/` for specific tool output (bash, edit, read, search, tasks, etc.).
- **`api.ts`** — Browser API wrapper. Chooses local vs remote transport, exposes remote login/admin helpers, and notifies conversation subscribers after mutating calls.
- **`transport/`** — Unified browser transport abstraction. `local.ts` uses EventSource against `/api/*`; `remote.ts` adapts the same UI to a remote CLI via encrypted polling.
- **`remote-client.ts`** — Browser-side remote auth/session client. Handles OPAQUE-based login, encrypted relay RPCs, saved remote login restore, and remote machine selection.
- **`hooks/`** — `use-event-source.ts` (SSE client), `use-page-visibility.ts` (tab visibility).

### Shared Types

Both backend and frontend import local app types from `api/storage.ts` via the path alias `@codex-deck/api` (configured in Vite and tsconfig). This is the single source of truth for interfaces like `Session`, `ConversationMessage`, `CodexThreadStateResponse`, etc.

Remote protocol/auth contracts live in `@zuoyehaoduoa/wire`; keep encrypted payload schemas and OPAQUE helpers there instead of duplicating route-local shapes.

### Tests (`tests/unit/`)

Node.js native `test` module executed via tsx for the root app. Test files use `*.test.ts` convention. Coverage includes backend parsing/routes, browser helpers, and remote bridge clients such as `remote-client.test.ts` and `remote-server-client.test.ts`. `test-utils.ts` provides fixtures for creating temporary Codex directory structures.

## Coding Conventions

- TypeScript strict mode, 2-space indent, double quotes
- File names: kebab-case for components, lowercase for entry points
- Types/interfaces: PascalCase. Variables/functions: camelCase
- Path normalization logic must stay consistent across `api/path-utils.ts` and `web/path-utils.ts`
- Commit style: short imperative subjects, optional `fix:`/`feat:` prefix

## Concurrent Access

Codex Deck may be accessed by multiple web pages (tabs/devices) or codex CLI instances at the same time. Be cautious about this. The backend uses several patterns to handle concurrency:

- **SSE fan-out**: `api/watcher.ts` maintains `Set`-based listener collections (`historyChangeListeners`, `sessionChangeListeners`). Every connected SSE client registers a callback; file-change events are broadcast to all. Multiple SSE routes (`/api/sessions/stream`, `/api/conversation/:id/stream`, `/api/terminal/stream`) each support unlimited concurrent subscribers.
- **Terminal write ownership**: There is a single shared terminal instance (singleton `LocalTerminalManager` in `api/local-terminal.ts`). All clients can **read** terminal output via SSE, but only one client may **write** at a time. Write access is governed by a `writeOwnerId` field — a client must call `POST /api/terminal/claim-write` to acquire ownership; other clients receive HTTP 403 on input/resize/interrupt until the owner releases. The frontend (`terminal-view.tsx`) requests ownership before each interaction.
- **Codex app-server**: A single `codex app-server` subprocess (singleton in `api/codex-app-server.ts`) serves all clients via RPC with monotonically increasing request IDs. Multiple clients can read thread state concurrently. For mutating operations (send message, interrupt), there is no internal locking — the external app-server serializes requests. Two clients sending messages to the same thread will both succeed; the app-server decides ordering.
- **Browser transport split**: `web/transport/index.ts` switches between local SSE transport and remote encrypted transport. Keep browser-facing semantics aligned across both modes so UI features do not behave differently just because the data path is remote.
- **Remote relay**: In remote mode, the local `api/remote/remote-server-client.ts` authenticates the CLI to the remote `server`, proxies only non-stream `/api/*` requests, and keeps a long-lived socket for machine registration/heartbeat. Browser live updates in remote mode currently use encrypted polling rather than direct SSE passthrough.
- **File watcher singleton**: `api/watcher.ts` uses reference counting (`watcherRefCount`) so a single Chokidar instance is shared. Per-path debounce (20ms) prevents duplicate events.
- **Frontend client IDs**: Each browser page generates a `crypto.randomUUID()` client ID (`web/app.tsx`) used to identify itself for terminal ownership and SSE streams. State is ephemeral — the backend files are the source of truth, and SSE pushes eventual-consistency updates.
- **No mutexes/locks beyond terminal ownership**: Node.js single-threaded event loop makes Map/Set operations atomic. Async I/O can interleave but does not cause data races on in-memory structures.

- **Background tab behavior**: When a browser tab is hidden (user switches tabs or minimizes), SSE connections are **closed** to save resources (`pauseWhenHidden` default in `web/hooks/use-event-source.ts`). The sessions stream is also gated by `enabled: isPageVisible` in `app.tsx`. This means **no updates are received while the page is in the background**. When the tab becomes visible again, the `useEventSource` hook listens for `visibilitychange`, `focus`, `pageshow`, and `online` events to trigger an immediate reconnection (retry count reset to 0). On reconnect, the server sends a full `sessions` event as the first SSE message, which replaces the client's stale session list. Additionally, a `useEffect` in `app.tsx` watching `isPageVisible` calls `syncSessionWaitState()` to re-fetch the selected session's current wait/generation state from the server. A 15-second health-check interval also detects stale connections (no event for 45 seconds) and forces a reconnect when the page is visible. Terminal SSE uses `fromSeq` replay so reconnecting clients catch up on buffered events (up to 2000). The net result is eventual consistency: background tabs go dormant and catch up fully on wake.

When adding new features, preserve these invariants:

1. All real-time state must be broadcast to every connected client via SSE.
2. Exclusive resources (like terminal write) must use an ownership/claim pattern — never assume a single client.
3. Singletons (terminal manager, codex app-server client, file watcher) must remain safe for concurrent callers.
4. Sequence-based replay (terminal events use `fromSeq`) must be maintained so reconnecting clients can catch up.

For remote-server work tracked in `docs/SERVER_IMPLEMENTATION.md`, preserve the same spirit:

1. The remote `server` is the browser entrypoint in remote mode.
2. The remote `cli` connects outward to `server`; browsers do not connect directly to `cli`.
3. Password bootstrap is the first connection flow.
4. `wire` remains the canonical encrypted payload boundary, and synced Codex payloads stay end-to-end encrypted.
5. Multi-browser access to one remote `cli` must remain safe, especially for terminal write ownership and live-update fan-out.

## Key Details

- The web page may be visited from another machine (and possibly from a mobile phone). Be cautious about this — ensure layouts are responsive, avoid localhost-only assumptions in URLs/assets, and do not rely on features unavailable on mobile browsers.
- Light mode and dark mode must both be designed intentionally. Do not leave a surface on dark-only classes just because it "looks acceptable" in one theme. When editing UI, check whether the surrounding pane, card, header, and empty states also need explicit light-mode treatment.
- For theme-specific styling, prefer matching existing repo patterns on comparable surfaces instead of inventing a new palette in isolation. If a component is intentionally dark in both themes (for example, a terminal emulator surface), keep that choice scoped to the true terminal surface and do not accidentally apply the same dark chrome to surrounding light-mode UI.
- Frozen/read-only blocks in light mode should use the repo's subtle light-theme surface language, not dark-mode zinc backgrounds and not ad-hoc heavy gray layering. The goal is a small but clear distinction from interactive blocks, while remaining visually consistent with adjacent light-mode UI.
- Interactive mode requires the `codex` binary on PATH (or set `CODEX_CLI_PATH` env var).
- SSE is used for real-time updates: session list changes and live conversation streaming.
- The Vite dev server proxies API requests to the backend, so both servers must run during development.
- **Fix dangling is manual-only**: The "Fix dangling" feature (`fixDanglingTurns`) appends synthetic completions to session files and must only be triggered by the user clicking the "Fix dangling" button. It must never be called automatically by server-side polling, thread-state fallback, or any background logic.
- Use these terms consistently in remote-server work:
  - `cli`: the codex-deck daemon/process running next to Codex on the local machine
  - `web app`: the codex-deck browser UI
  - `server`: the remote codex-deck server that browsers connect to
- Keep local mode intact while implementing remote mode. The remote path is additive, not a replacement for the existing `pnpm dev` / `pnpm start` workflows.
- For local remote-mode debugging, prefer the local skill `.claude/skills/codexflow-remote-local/` to start the local remote `server`, local remote `cli`, or both with the repo's standard defaults and overrides, but only use that skill when Docker is available. After startup, use `playwright-interactive` when browser-side debugging is helpful, and prefer a headed browser so the user can see each operation.
- For the `.claude/skills/codex-deck-flow/` skill, prompt text in the `Roles` section must exactly match the corresponding prompt content used by the skill scripts.
- In codex-deck-flow prompts and docs, use descriptive line-style placeholders (for example, `[file path for new tasks to be saved]`) instead of compact token placeholders (for example, `[new-tasks-file-path]`).
- Whenever the codex-deck-flow skill is updated, update `.claude/skills/codex-deck-flow/references/agent-flow-design.md` in the same change.
- Whenever codex-deck-flow skill APIs, scripts, or logic change, update the Workflow UI and `docs/WORKFLOW_UI.md` in the same change if they are affected.
- Whenever the Workflow UI changes, update `docs/WORKFLOW_UI.md` in the same change.
- Remote-server architecture work belongs in `server/` and `wire/`.
