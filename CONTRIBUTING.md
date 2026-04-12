# Contributing to codex-deck

Thanks for contributing. This guide is for changes to this repository (root app, `server/`, and `wire/`).

## Prerequisites

- Node.js 20+
- `pnpm`
- Git
- Codex CLI installed and initialized at least once (required for interactive features)

## Getting Started

```bash
git clone https://github.com/asfsdsf/codex-deck.git
cd codex-deck
pnpm install
pnpm dev
```

`pnpm dev` starts:

- frontend dev server on `:12000`
- backend API server on `:12001`

## Development Commands

### Root app (`api/` + `web/`)

- `pnpm dev` - run frontend and backend in watch mode
- `pnpm dev:web` - run Vite frontend only
- `pnpm dev:server` - run backend only
- `pnpm build` - production build (builds `wire` first)
- `pnpm test` - root unit tests
- `pnpm exec tsx --tsconfig tsconfig.test.json --test tests/unit/<file>.test.ts` - run one root test file
- `pnpm exec prettier --write .` - format files

### `wire/` package

- `pnpm --dir wire build`
- `pnpm --dir wire test`

### `server/` package (remote adoption target)

- `pnpm --dir server dev`
- `pnpm --dir server build`
- `pnpm --dir server test`

## Validation Before Submitting

Run checks based on what you changed:

- `api/` or `web/` changes: `pnpm test` and `pnpm build`
- `wire/` changes: `pnpm --dir wire test`
- `server/` changes: `pnpm --dir server test` and `pnpm --dir server build`
- cross-cutting remote/auth changes: run all relevant checks above

Formatting should be clean before PR:

```bash
pnpm exec prettier --write .
```

## Coding Guidelines

- TypeScript strict mode, 2-space indent, double quotes
- File names: kebab-case for components, lowercase for entry points
- Types/interfaces: PascalCase. variables/functions: camelCase
- Keep path normalization behavior aligned across `api/path-utils.ts` and `web/path-utils.ts`
- Keep local and remote browser semantics aligned when changing transport or API behavior

## Architecture Guardrails

- `api/` is the current production backend for local mode
- `server/` and `wire/` are staged remote adoption work; read `docs/SERVER_IMPLEMENTATION.md` before major architectural changes there
- The "Fix dangling" action is manual-only and must never run automatically in background logic

Preserve concurrency invariants:

1. Real-time state must fan out to all connected clients.
2. Exclusive resources (such as terminal write) must use ownership/claim patterns.
3. Shared singletons must remain safe for concurrent callers.
4. Sequence-based replay behavior must be preserved for reconnect catch-up.

## Pull Request Workflow

1. Create a focused feature/fix branch.
2. Keep changes scoped to one intent.
3. Run validation commands for touched surfaces.
4. Update docs when behavior changes.
5. Open a PR with clear `what`, `why`, and test evidence.

Commit messages should be short imperative subjects. `feat:` and `fix:` prefixes are welcome.

## Docs and Cross-File Update Expectations

- If codex-deck-flow skill behavior/API/scripts change, update related docs in the same change.
- If Workflow UI behavior changes, update `docs/WORKFLOW_UI.md` in the same change.
- If touching `server/`, also follow package-specific rules in `server/CLAUDE.md`.
- For broader architecture and invariants, use `AGENTS.md` as source of truth.

## Other Ways to Contribute

- Report bugs and confusing UX
- Improve docs
- Test behavior on different browsers/devices (including mobile)
- Propose features with concrete user flows
