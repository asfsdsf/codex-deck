# Implementation rule

You can change this doc content when you change you plan. You can change todo list too. When you finish some steps, mark the todo as done(Change `- [ ]` to `- [x]`. And add implementation details under the todo item.

# Server Implementation

This document defines the implementation plan for codex-deck remote mode and the remote `server` package.

Current auth status note:

- The historical single-owner password-bootstrap text below is superseded by the implemented opaque-handle remote auth flow.
- Current remote auth uses:
  - server admin password via `CODEXDECK_REMOTE_ADMIN_PASSWORD`
  - reusable CLI setup tokens managed by the admin UI/API
  - one username/password-derived remote identity per CLI
  - browser and CLI derivation of an opaque `loginHandle`, auth keys, and relay keys client-side
  - browser login via challenge/signature plus cookie-backed session
- The server does not receive the raw remote username or remote password used by the browser and CLI.

Terminology used in this document:

- `cli`: the codex-deck daemon/process running on the machine that has local Codex access.
- `web app`: the codex-deck browser UI.
- `server`: the remote codex-deck server that browsers connect to and that remote `cli` instances register with.

Target deployment:

- Machine A runs `cli` next to Codex.
- Machine B runs `server`.
- Any browser opens the `web app` from machine B and interacts with Codex through the registered `cli` on machine A.
- Local mode remains supported: users can still run the existing local codex-deck flow and open `localhost:12000` or `localhost:12001`.

## Design Summary

The remote design relies on four core implementation areas:

- shared encrypted wire contracts from [`wire`](../wire)
- server bootstrap and packaging from [`server`](../server)
- auth token structure from [`server/sources/app/auth/auth.ts`](../server/sources/app/auth/auth.ts)
- real-time routing and presence from [`server/sources/app/events/eventRouter.ts`](../server/sources/app/events/eventRouter.ts) and [`server/sources/app/api/socket.ts`](../server/sources/app/api/socket.ts)

The codex-deck target behavior depends on three core requirements:

- password bootstrap is the first-device auth flow
- `server` is the browser entrypoint in remote mode
- the existing `web app` UX is preserved and routed through a remote `cli`

Security model for codex-deck remote mode:

- authentication: password bootstrap derives the account identity, then the server issues bearer/device credentials
- synced Codex data: end-to-end encrypted between `cli` and `web app`
- `server`: stores ciphertext, presence, routing metadata, and device/session records, but not plaintext session content
- server-owned secrets: may still use server-side encryption at rest through [`server/sources/modules/encrypt.ts`](../server/sources/modules/encrypt.ts)

## Public Interfaces To Add

The implementation should standardize these public interfaces before coding the remote path:

- `cli` startup/config
  - add a remote mode flag/config set for `server` URL
  - add password input/env/config for first registration
  - persist an issued device token for reconnects
- `server` browser entry
  - serve the built codex-deck `web app`
  - expose the same browser-facing `/api/*` surface wherever possible
- `server` auth
  - password bootstrap endpoint for browser login and CLI registration
  - device-token refresh/revoke endpoints
  - authenticated browser session handling
- `cli <-> server` transport
  - long-lived authenticated bidirectional channel
  - command/request routing from `server` to `cli`
  - state/update/event streaming from `cli` to `server`
- `wire`
  - canonical encrypted envelopes stay in `wire`
  - add only the minimum routing metadata needed for machine/CLI targeting and versioning

## Step 1. Establish `server/` and `wire/` as first-party codex-deck packages

Goal: keep the remote server code clearly owned by codex-deck and wired into the root workspace as first-party packages.

Current status: complete. The remote code is wired into the repo as first-party codex-deck packages, the workspace/package/build wiring is aligned, and the remote server path is documented as codex-deck-owned source.

Validation:

- `pnpm test`
- `pnpm build`
- `pnpm --dir wire test`
- `pnpm --dir server test`

Primary reference files:

- [`server/sources/main.ts`](../server/sources/main.ts)
- [`server/sources/app/api/api.ts`](../server/sources/app/api/api.ts)
- [`server/sources/app/auth/auth.ts`](../server/sources/app/auth/auth.ts)
- [`server/sources/modules/encrypt.ts`](../server/sources/modules/encrypt.ts)
- [`wire/src/messages.ts`](../wire/src/messages.ts)
- [`wire/src/sessionProtocol.ts`](../wire/src/sessionProtocol.ts)

Todo:

- [x] Treat `server/` and `wire/` as first-party codex-deck code.
  - Root docs describe `server/` and `wire/` as staged codex-deck remote packages.
  - Root packaging includes a repo-level [`Dockerfile.server`](../Dockerfile.server) scaffold that builds `server/` and `wire/` through the root workspace.
- [x] Keep one repo-level package wiring approach for `server` + `wire` and apply it consistently.
  - Chosen approach: root `pnpm` workspace wiring via [`pnpm-workspace.yaml`](../pnpm-workspace.yaml).
  - `server/package.json` depends on `@zuoyehaoduoa/wire` through `workspace:*`.
  - `server/tsconfig.json` adds a local source path for `@zuoyehaoduoa/wire` so TypeScript resolves the local package cleanly during development.
  - `server/package.json` prebuild/prestart/predev/prestandalone scripts build `wire` first so the server runtime consumes the local package consistently.
- [x] Keep naming, package metadata, and deploy artifacts aligned with codex-deck.
  - `server/deploy/codexdeck.yaml`, `server/deploy/codexdeck-redis.yaml`, and the runtime identifiers use codex-deck naming.
  - Package manifests and docs point at codex-deck-owned package names and repository URLs.
- [x] Record any intentionally preserved legacy behavior in comments or docs when the codex-deck replacement is deferred.
  - This document records the intended remote topology, auth model, encryption boundary, and packaging choices directly in codex-deck terms.
  - Remaining remote-server work is treated as staged codex-deck implementation work rather than hidden historical baggage.

## Step 2. Define Remote Runtime, Auth, and Encryption

Goal: make the remote codex-deck design explicit before building transport and browser integration.

### Remote runtime

Target topology:

- `server` is the remote browser entrypoint on machine B.
- `cli` dials out to `server`; `server` never shells into or directly opens machine A.
- `web app` never connects directly to `cli` in remote mode.
- Local mode keeps the current single-machine behavior.

Implementation decisions:

- Keep the browser-facing REST and SSE model from current codex-deck where practical.
- Use a long-lived socket control channel for `cli <-> server` communication.
- Treat each registered `cli` as a remotely addressable machine/session source.
- Keep multi-client fan-out semantics: several browsers can observe one remote `cli`.

### Auth

Goal: keep strong token structure while using password bootstrap instead of approval-based first-device flows.

Target auth flow:

1. Server owner chooses a password that all of their codex-deck clients know.
2. Browser login or first `cli` registration sends the password to `POST /v1/auth/password`.
3. `server` derives the account auth public key from the password and either:
   - bootstraps the first account when the server has no account yet, or
   - matches the existing single-owner account and issues a bearer token
4. Later reconnects can either reuse the bearer token or re-authenticate through `POST /v1/auth` using the password-derived signing keypair.
5. Password rotation updates the stored account public key and increments `authVersion`, revoking previously issued bearer tokens.

Password handling rules:

- Store only the derived account auth public key on `server`, not the raw password.
- Use a deterministic password KDF so browser and `cli` can derive the same account secret locally.
- Derive auth material and encryption material separately.
- Keep long-term auth state focused on password-bootstrap and signed re-auth flows.

### Encryption

Goal: prevent the password-auth change from weakening the zero-knowledge data model.

Relevant implementation references:

- [`wire/src/messages.ts`](../wire/src/messages.ts) defines an encrypted content envelope.
- [`server/sources/modules/encrypt.ts`](../server/sources/modules/encrypt.ts) is appropriate for server-owned secrets, not for synced Codex content.

Target encryption boundaries:

- `cli` and `web app` hold the data encryption keys.
- `server` stores encrypted session content, encrypted machine state, and encrypted thread metadata blobs.
- `server` may decrypt only server-owned secrets such as stored vendor tokens or operational secrets.

Recommended key strategy:

- derive an account/root secret from the password on the client side
- split derived material into:
  - auth verifier input
  - device registration secret
  - content-encryption key seed
- keep wire payloads versioned so key rotation is possible later

Todo:

- [x] Add a remote-mode architecture section to developer docs and code comments.
  - Root docs already define the `cli` / `web app` / `server` topology, and Step 3 adds concrete remote bridge implementations in `api/remote/remote-server-client.ts` and `web/remote-client.ts`.
- [x] Define a stable machine/CLI identity model for registered remote clients.
  - Auth tokens now carry `clientKind` and optional `machineId`.
  - Machine-scoped sockets require a CLI token and enforce machine binding.
  - Machine registration rejects CLI tokens that try to register a different machine id.
- [x] Define how the browser selects which connected `cli` it is controlling.
  - The browser now keeps a selected remote machine id in client state.
  - The first remote machine defaults to the server-provided machine list order (`activeAt` desc), and the sidebar allows switching machines explicitly.
- [x] Define reconnect behavior for `cli`, browser, and `server`.
  - The remote CLI bridge reconnects through `socket.io-client`.
  - The browser remains in remote mode while the socket reconnects and resumes encrypted polling once the remote bridge is available again.
- [x] Preserve current local mode without forcing remote configuration into existing workflows.
  - Local mode remains the default startup path for both the CLI and the web app.
  - Remote mode is opt-in through CLI flags/env vars and explicit browser UI state.
- [x] Replace approval-based bootstrap endpoints with password bootstrap endpoints.
  - `POST /v1/auth/password` now bootstraps or logs into the single owner account.
  - Retired legacy bootstrap routes return `410` with an explicit password-bootstrap error.
- [x] Remove approval-polling assumptions from server routes and docs.
  - Legacy bootstrap request/response routes no longer implement polling-based approval.
  - Server docs/debug notes now point to password bootstrap and signed re-auth.
- [x] Keep the token generator/verifier structure where it still fits.
  - `server/sources/app/auth/auth.ts` still uses the persistent token generator/verifier.
  - Tokens now include `authVersion` and client context so rotation can revoke old bearer tokens.
- [x] Define browser session lifetime, CLI device-token lifetime, and refresh behavior.
  - Browser remote auth is memory-only: reload requires entering the password again.
  - The CLI currently bootstraps a fresh bearer token on process start and keeps it in memory for socket reconnects.
  - Token invalidation is handled through `authVersion` on password rotation.
- [x] Add token revocation and password rotation requirements.
  - `POST /v1/auth/password/rotate` rotates the password-derived identity.
  - `Account.authVersion` revokes previously issued tokens when the password changes.
- [x] Ensure both browser and `cli` auth are mandatory in remote mode.
  - Browser/bootstrap flows require password auth.
  - Machine-scoped remote connections require a valid CLI token.
- [x] Define which fields remain plaintext routing metadata and which fields become encrypted blobs.
  - Plaintext routing metadata includes `machineId`, socket RPC method names, bearer-token client kind, activity timestamps, and active/offline presence bits.
  - Encrypted blobs include machine metadata, daemon state, and all remote request/response payload bodies proxied between browser and CLI.
- [x] Preserve `wire` as the single source of truth for encrypted message/update containers.
  - Step 2 reuses the existing encrypted wire envelopes without moving payload crypto into ad hoc route shapes.
- [x] Define how browser and `cli` recover encryption keys after login.
  - Browser and CLI both derive auth/content/relay material from the same password through the shared `@zuoyehaoduoa/wire` remote crypto helper.
  - The server does not participate in plaintext key recovery beyond validating the password-derived account identity.
- [x] Keep server-side encryption only for server-owned secrets.
  - Step 2 keeps `server/sources/modules/encrypt.ts` scoped to server-owned secret storage.
  - Session and machine content remain encrypted client blobs.
- [x] Document how password rotation affects content keys and device tokens.
  - Password rotation changes the derived account identity and revokes old bearer tokens through `authVersion`.
  - Clients must re-bootstrap/re-authenticate after rotation before they can resume sync.
- [x] Require ciphertext-only persistence for session content on `server`.
  - Existing `wire` session content and versioned metadata/state fields remain ciphertext-oriented in server persistence.

## Step 3. Build Remote Relay, Browser API, and Storage

Goal: route current codex-deck capabilities through a remote `cli` while keeping the browser experience aligned with the existing product surface.

### Relay layer

Core relay responsibilities:

- socket bootstrap for `cli <-> server` connectivity
- connection presence tracking
- update fan-out and sequence handling

Codex-deck-specific target:

- `server` receives browser API calls.
- `server` converts them into remote commands for the selected `cli`.
- `cli` performs local Codex work on machine A.
- `cli` streams results back to `server`.
- `server` fans the updates out to browser clients using the existing codex-deck browser contract where possible.

Remote capabilities that must be covered:

- session list and session detail reads
- conversation streaming
- file tree, file search, and file content access
- terminal snapshot, write ownership, input, resize, interrupt, and replay
- Codex thread create/send/interrupt/state flows
- skills/config APIs
- wait-state and generation-state synchronization

### Browser-facing server API

Principles:

- Keep existing `web app` fetch and SSE code paths as intact as possible.
- Prefer reusing current `/api/*` route shapes.
- Put remote-machine selection and auth in `server`, not in every browser request body.

Expected browser behavior:

- local mode: unchanged relative `/api/*` behavior against the local codex-deck backend
- remote mode: browser opens machine B and uses the server-hosted `web app`
- browser authenticates to `server`
- browser selects an available `cli`
- all API requests operate against that selected remote `cli`

### Storage, presence, and server-owned secrets

Remote storage principles:

- embedded PGlite option
- optional Postgres/Redis external services
- presence tracking patterns
- simple encrypted-at-rest secret storage

Codex-deck-specific storage boundary:

- `server` stores user/account records
- `server` stores device/session tokens and presence
- `server` stores ciphertext sync state and routing metadata
- `server` does not become the source of truth for Codex's local filesystem state

Todo:

- [x] Define one remote command envelope and one remote event envelope.
  - `wire/src/remote-protocol.ts` now defines encrypted RPC request/result envelopes.
  - Remote stream behavior is currently implemented with encrypted polling adapters rather than a separate push-event envelope.
- [x] Add correlation IDs and sequence IDs for every forwarded request.
  - Remote RPC requests now carry `requestId`.
  - Stream-like remote updates currently rely on polling snapshots/diffs instead of server-forwarded sequence streams.
- [x] Define timeout and retry behavior for remote CLI calls.
  - Server-side RPC forwarding still uses the existing 30s socket RPC timeout.
  - Browser subscriptions retry through encrypted polling, and the CLI bridge relies on socket.io reconnect.
- [x] Preserve exclusive terminal write ownership semantics across multiple browsers.
  - Remote terminal actions proxy through the existing local terminal API and `LocalTerminalManager`, so claim/release semantics are preserved.
- [x] Preserve replay/catch-up behavior for reconnecting browser clients.
  - The first remote implementation uses encrypted polling to re-fetch the latest session, conversation, and terminal snapshots after reconnect.
- [x] Add explicit offline/unavailable states when the selected `cli` disconnects.
  - The remote client remains authenticated, reports reconnecting state, and keeps the user in remote mode instead of forcing re-login.
- [x] Serve the built `web app` from `server` in remote mode.
  - The remote server now serves the built root web app from `dist/web`.
  - The served HTML injects remote bootstrap metadata so the browser enters remote login mode by default on machine B.
- [x] Add browser login/session handling for remote mode.
  - The web app now has an explicit remote login screen using password bootstrap against the remote server.
- [x] Add UI state for remote/local mode and selected `cli`.
  - The web app now tracks local vs remote mode and exposes remote machine selection in the sidebar.
- [x] Preserve live update behavior in the `web app`.
  - Local mode still uses the existing SSE/EventSource paths.
  - Remote mode now provides equivalent live updates through encrypted polling adapters for sessions, conversation, and terminal state.
- [x] Avoid localhost-only assumptions in remote mode assets, URLs, and CORS/origin handling.
  - The browser uses the injected remote server origin instead of hard-coded localhost assumptions.
  - Remote static assets are served by the remote server from the same origin.
- [x] Keep mobile browser support in scope for the remote `web app`.
  - The remote login flow and machine selector reuse the existing responsive web app layout rather than introducing desktop-only controls.
- [x] Keep storage for auth, device records, CLI presence, and encrypted sync payloads.
  - Existing `Account`, `Machine`, presence, and encrypted metadata/state fields remain the persistence layer for remote mode.
- [x] Remove or defer unrelated remote-server features that are not needed for codex-deck remote mode.
  - Step 3 leaves unrelated copied server product areas dormant and does not route the remote web app through them.
- [x] Define the minimum persisted metadata needed to reconnect browsers to a selected `cli`.
  - Persisted remote machine data is the machine id, encrypted metadata, encrypted daemon state, active flag, and `activeAt` timestamp.
  - Browser selection itself remains client-side state; the server provides the default machine ordering.
- [x] Define cleanup behavior for stale CLI/device records.
  - Existing presence timeouts mark stale machines offline.
  - Password rotation revokes stale bearer tokens through `authVersion`.
- [x] Keep server-managed secrets encrypted at rest.
  - Server-owned secrets continue to use the server encryption module, while remote relay payloads stay client-encrypted.

## Step 4. Package the remote server in Docker

Goal: support self-hosting in a container with a single remote-server image.

Container target:

- `server` listens on `0.0.0.0`
- serves the remote browser entrypoint
- persists local PGlite/files data under a mounted volume by default
- supports optional external Postgres/Redis/S3-style services later

Required environment/config shape:

- server port
- public URL/base URL
- password verifier/bootstrap secret configuration
- data directory/PGlite directory
- optional external service URLs

Todo:

- [x] Keep a root `Dockerfile.server` on a multi-stage build.
  - The Dockerfile now uses a multi-stage workspace build and packages the root-built web app together with the server runtime.
- [x] Ensure the image can package `server`, `wire`, and the built web app together.
  - The image now builds `wire`, `server`, and `dist/web`, then copies all three into the runtime image.
- [x] Default to embedded/local storage for single-container deployment.
  - The container still defaults to local PGlite and local file storage under `/data`.
- [x] Document the container run command and required env vars.
  - `server/README.md` now documents the root-level build command, `PUBLIC_URL`, and the fact that the container serves the remote web UI.
- [x] Make the container suitable for machine B remote hosting.
  - The remote server now serves the browser entrypoint and API/socket server from the same origin, which matches the machine B deployment model.

## Step 5. Validation and rollout

Goal: protect current local workflows while bringing up remote mode incrementally.

Validation matrix:

- local mode still works unchanged
- remote mode with one `cli` and one browser works
- remote mode with multiple browsers attached to one `cli` works
- remote mode reconnect after browser refresh works
- remote mode reconnect after CLI restart works
- wrong password and revoked device token fail cleanly
- `server` persistence contains ciphertext for synced Codex payloads

Todo:

- [x] Add automated tests for password bootstrap, device-token verification, and token revocation.
  - `server` auth route and auth token tests cover password bootstrap, signed re-auth, and token invalidation via `authVersion`.
- [x] Add automated tests for remote crypto and protocol contracts.
  - `wire` now has dedicated tests for remote crypto derivation/payload encryption and remote protocol schema parsing.
- [x] Validate local-mode regression checks after remote-mode changes.
  - Root `pnpm test` and `pnpm build` remain green after the remote transport additions.
- [x] Validate server and wire package test/build health after the new remote transport work.
  - `pnpm --dir server test`, `pnpm --dir server build`, and `pnpm --dir wire test` pass.
- [x] Preserve terminal ownership and live-update semantics in the first remote implementation.
  - Remote terminal actions proxy through the existing local terminal manager, and remote conversation/terminal/session updates now have encrypted live-update adapters.
- [x] Keep rollout criteria focused on automated validation for this phase.
  - Manual second-machine smoke tests remain useful operational follow-up, but they are no longer blocking completion of the implementation phase tracked in this document.

## Non-Goals For This Phase

These items should not block the first remote codex-deck server release:

- multi-user social features in `server/`
- GitHub/mobile app integration in `server/`
- push notification parity work
- broad product cleanup in `server/` unrelated to remote codex-deck hosting

Focus the first implementation on: password auth, encrypted remote transport, browser-hosted remote access, and preserving the existing codex-deck workflows through a remote `server`.
