# Terminal Pane Implementation

## Purpose

The terminal pane is the live shell surface in codex-deck. It serves two related jobs:

1. Provide a shared interactive terminal for a project directory.
2. Attach that terminal to a Codex session so the UI can show AI terminal directives, approvals, and frozen terminal snapshots in the same pane.

This is not a standalone frontend widget. The pane is a cross-cutting feature implemented across `web/app/codex-deck-app.tsx`, `web/components/terminal-view.tsx`, `web/transport/*`, `api/server/terminal-routes.ts`, `api/local-terminal.ts`, and the terminal artifact persistence modules under `api/`.

## High-Level Design

The terminal pane is built around a single local singleton manager:

- `api/local-terminal.ts` owns all live terminal processes.
- Each terminal has a stable `terminalId`.
- Each browser page gets its own `clientId`.
- Many clients may subscribe to the same terminal output.
- Only one client may write at a time.

The design intentionally separates four concerns:

1. Live process management
   `LocalTerminalManager` creates, restarts, resizes, and disposes shell processes.
2. Realtime fan-out
   Terminal state is streamed to every connected client through SSE, with `seq`-based replay.
3. Session binding
   A terminal may be bound to one Codex session, persisted on disk, and restored after reload.
4. Artifact rendering
   AI terminal messages and captured snapshots are persisted and then re-rendered as timeline entries inside the pane.

## User-Facing Composition

The terminal pane is mounted from `web/app/codex-deck-app.tsx` when `centerView === "terminal"`.

`TerminalView` receives:

- `terminalId`
- `boundSessionId`
- embedded session messages already resolved by the app
- callbacks for restart, chat bootstrap, file link navigation, and AI step approval/rejection

The app-level responsibilities are:

- track the selected terminal from the terminal list
- create or bind a Codex session for that terminal
- fetch the session messages that should appear as timeline cards
- keep the composer footer aligned with the currently bound session

`TerminalView` itself is intentionally narrower. It owns the xterm instance, the terminal stream subscription, input buffering, write ownership state, and the merged rendering of:

- live PTY output
- frozen terminal snapshots
- embedded AI terminal cards

## Backend Architecture

### Terminal manager

`api/local-terminal.ts` defines `NodePtyLocalTerminalManager`, a singleton returned by `getLocalTerminalManager()`.

Each `TerminalInstance` stores:

- process handle
- cwd and shell metadata
- `running` state
- monotonically increasing `seq`
- accumulated output buffer
- buffered recent events
- `writeOwnerId`
- first typed command
- `TerminalSnapshotCapture` state for future frozen snapshots

Important implementation details:

- PTY mode uses `node-pty` when available.
- If `node-pty` cannot start, the code falls back to a plain pipe-based interactive shell and emits a startup notice into terminal output.
- Output is capped at `MAX_OUTPUT_CHARS` and event replay is capped at `MAX_BUFFERED_EVENTS`.
- Restart clears output, clears ownership, publishes `reset` and `ownership` events, then starts a fresh shell.

### Event model

The terminal stream uses typed events from `api/storage/runtime.ts`:

- `bootstrap`
- `output`
- `state`
- `reset`
- `ownership`
- `artifacts`

`seq` is the only ordering primitive. Clients use it to:

- ignore duplicates
- resume from the last applied event
- detect replay gaps

`TerminalInstance.getEventsSince()` returns either:

- incremental events after `fromSeq`, or
- `requiresReset: true` when the client asked for a sequence older than the buffered window

That reset path is what keeps reconnect behavior simple: if replay is impossible, the server sends a full snapshot and the client redraws from scratch.

### HTTP and SSE routes

`api/server/terminal-routes.ts` exposes the terminal API.

Core list and lifecycle routes:

- `GET /api/terminals`
- `POST /api/terminals`
- `DELETE /api/terminals/:terminalId`
- `POST /api/terminals/:terminalId/restart`

Input and ownership routes:

- `POST /api/terminals/:terminalId/input`
- `POST /api/terminals/:terminalId/resize`
- `POST /api/terminals/:terminalId/claim-write`
- `POST /api/terminals/:terminalId/release-write`

Realtime routes:

- `GET /api/terminals/stream` for terminal list updates
- `GET /api/terminals/:terminalId/stream` for per-terminal SSE
- `GET /api/terminals/:terminalId/events` for long-poll style transport parity and remote mode

Binding and artifact routes:

- `POST /api/terminals/:terminalId/binding`
- `POST /api/terminals/:terminalId/message-action`
- `POST /api/terminals/session-roles`

### Write ownership

Write ownership is enforced server-side, not just in the browser.

Rules:

- Any number of clients may subscribe and read output.
- At most one `clientId` owns writes.
- `input` may auto-claim ownership when the terminal has no owner and a `clientId` is provided.
- `resize` requires current ownership and does not auto-claim.
- `restart` is denied when another client owns the terminal.
- SSE disconnect cleanup releases ownership for the disconnecting stream client.

This is the core concurrency invariant for terminal safety across tabs/devices.

### Persistence and rehydration

The terminal pane persists enough metadata to survive UI reloads when a terminal is bound to a session.

Modules:

- `api/terminal-state.ts`
- `api/terminal-bindings.ts`

Persisted state includes:

- `terminalId`
- `cwd`
- `shell`
- first command
- timestamp

Bindings are stored as disk-backed one-to-one indexes:

- terminal -> session
- session -> terminal

`TerminalBindingConflictError` prevents one session from being bound to multiple terminals. On process startup, `rehydrateBoundTerminals()` recreates terminal instances from persisted state only for terminals that still have bindings.

Behavior on exit is deliberate:

- stopped unbound terminals are removed
- stopped bound terminals are kept in the list so the session context remains attached and the terminal can be restarted

## Session Binding and Artifact Model

### Why artifacts exist

The pane is not only a shell emulator. Once a terminal is bound to a Codex session, the UI needs to preserve structured AI interactions that happen around the shell:

- approval plans
- need-input requests
- completion cards
- frozen terminal snapshots captured around those messages

Those are modeled as terminal session artifacts.

### Artifact storage

`api/terminal-session-store.ts` persists terminal-session data under the Codex home directory. The storage model is:

- one manifest per terminal session store
- one block record per persisted artifact
- optional serialized snapshot payloads for frozen terminal captures

Block types:

- `terminal_snapshot`
- `ai_terminal_plan`
- `ai_terminal_need_input`
- `ai_terminal_complete`

Snapshots are stored as serialized xterm content with:

- format `xterm-serialize-v1`
- `cols`
- `rows`
- serialized buffer data

### Artifact sync

`api/terminal-session-sync.ts` rebuilds artifact state from the bound conversation and persisted terminal data.

The sync flow is:

1. Load the session conversation.
2. Parse assistant messages that embed AI terminal directives.
3. Persist message blocks for plan / need-input / complete cards.
4. Consume any pending frozen terminal snapshot from `TerminalSnapshotCapture`.
5. Persist snapshot blocks and rebuild timeline entries.
6. Publish an `artifacts` event if the payload changed.

Artifact publication is triggered from two places:

- session file watcher changes via `onSessionChange(...)`
- terminal binding changes via `onTerminalBindingChange(...)`

This keeps the terminal pane eventually consistent with session updates even when the session changes outside the pane.

### When a terminal block is frozen

There is no separate "freeze this block now" endpoint. Freeze is an artifact-sync side effect.

The actual mechanism is:

1. `TerminalInstance` mirrors every live output chunk into `TerminalSnapshotCapture`.
2. That capture buffer stays pending in memory while the terminal continues running.
3. When artifact sync runs for a bound terminal/session pair, the sync logic walks AI-terminal assistant messages in conversation order.
4. For each parsed AI-terminal directive, it checks whether a `terminal_snapshot` block already exists for that message key.
5. If no snapshot exists yet, sync calls `consumePendingSnapshot()`.
6. If the capture buffer has content, the returned serialized xterm snapshot is persisted as a frozen block and inserted into the timeline before the corresponding AI card.

In code terms, freezing is driven by `syncTerminalSessionArtifacts(...)` in `api/terminal-session-sync.ts`, not by the frontend renderer.

Important consequences:

- A snapshot is frozen only when there is both:
  - a bound session with a parsed AI-terminal directive message, and
  - pending captured terminal output that has not already been consumed
- `consumePendingSnapshot()` is destructive. Once sync consumes a snapshot, the capture buffer resets and later sync runs need fresh terminal output to create another frozen block.
- If there is already a snapshot block for the same logical message key, sync reuses it and does not capture a new one.
- If there is no pending output when sync runs, no frozen block is created for that directive.

### Freeze timing and capture kinds

Artifact sync can run in several situations:

- when the terminal stream bootstraps and loads artifacts
- when session files change and the watcher publishes updates
- when terminal binding changes
- immediately before persisting a plan step approval/rejection via `POST /api/terminals/:terminalId/message-action`

The current capture-kind rule is code-defined:

- `captureKind: "manual"` for `plan` and `need_input` directives
- `captureKind: "auto"` for `finished` directives

That naming is implementation metadata, not a literal UI button distinction. In current code, "manual" means the snapshot is associated with an actionable or user-gated AI terminal directive rather than a terminal-complete message.

Timeline ordering is also explicit:

- snapshot block sequence = `index * 2 + 1`
- message card sequence = `index * 2 + 2`

So a frozen terminal snapshot is rendered immediately before the AI directive card it contextualizes.

### Snapshot capture

`api/terminal-snapshot.ts` uses `@xterm/headless` and `@xterm/addon-serialize`.

`TerminalSnapshotCapture` mirrors the live stream by:

- receiving every output chunk
- resizing when the live terminal resizes
- serializing the headless buffer on demand
- resetting after a snapshot is consumed

This is intentionally separate from the visible xterm instance in the browser. The server owns the canonical frozen snapshot so artifacts remain stable across clients.

## AI Interaction Flow

### Bootstrap into a terminal-bound chat

The AI interaction loop starts when the user initializes terminal chat for a selected terminal in `web/app/codex-deck-app.tsx`.

The app:

1. creates or reuses a Codex thread for the terminal's `cwd`
2. sends a bootstrap message built by `buildTerminalChatBootstrapMessage(...)`
3. binds the resulting session to the terminal with `POST /api/terminals/:terminalId/binding`

That bootstrap message includes:

- terminal id
- cwd
- shell
- OS release / architecture / platform
- optional first user request
- an instruction to use the `codex-deck-terminal` skill and emit exactly one terminal tag block

The assistant is therefore expected to respond with one of:

- `<ai-terminal-plan>`
- `<ai-terminal-need-input>`
- `<requirement_finished>`

### How AI replies become terminal cards

Conversation updates for the bound session are subscribed separately from the terminal PTY stream.

On each assistant message batch:

1. the app filters assistant messages through `parseAiTerminalMessage(...)`
2. each parsed directive is assigned a stable `messageKey`
3. persisted step states are derived from later feedback messages
4. `TerminalView` receives those embedded messages as actionable cards

The visual result in the terminal pane is:

- live shell output at the top
- frozen snapshots and AI terminal cards below, in artifact timeline order

### Plan approval flow

When the assistant emits an `<ai-terminal-plan>`, each step can be approved or rejected from the rendered card UI in `web/components/message-block.tsx`.

On approval, `handleApproveAiTerminalStep(...)` currently does this:

1. marks the step locally as `running`
2. converts the step command into terminal input with a trailing newline
3. sends that input to the shared terminal
4. if another client owns writes, temporarily claims write ownership, sends the command, then releases ownership
5. persists the approved action through `POST /api/terminals/:terminalId/message-action`
6. sends a structured `<ai-terminal-execution>` message back into the bound Codex session

One current implementation detail matters:

- the approval flow does not wait for the shell command to finish
- it does not infer a real exit code from terminal output
- it reports the step back to the AI as dispatched to the shared terminal, which becomes execution status `completed_unknown` because `exitCode` is `null`

So the current controller model is "approve and inject into the live terminal", not "run in a supervised subprocess and return exact completion state".

### Rejection flow

On rejection, `handleRejectAiTerminalStep(...)`:

1. marks the step locally as `rejected`
2. persists the rejection through `POST /api/terminals/:terminalId/message-action`
3. sends a structured `<ai-terminal-feedback>` message into the bound Codex session

The AI then uses that rejection reason to revise the next plan.

### Need-input flow

If the assistant emits `<ai-terminal-need-input>`:

- the terminal pane shows an input-needed card
- no terminal command is injected
- the user continues in the normal chat composer
- the follow-up user message becomes additional context for the next assistant reply

This is the branch used when the AI cannot safely propose a command yet.

### Completion flow

If the assistant emits `<requirement_finished>`:

- the pane renders an "AI Terminal Complete" card
- artifact sync labels its associated snapshot `captureKind: "auto"`
- no approval buttons are shown

This is the terminal-chat terminal state for the current request, although the bound chat session can still continue later.

### Restart notices

If the user restarts the terminal, the UI sends a bound-session notice from `web/terminal-session-notices.ts` stating that shell state may have been lost.

That notice is explicitly phrased so the AI should not treat it as a new task request. Its purpose is to keep future terminal plans grounded in the fact that:

- environment variables may be gone
- aliases/functions may be gone
- previous running processes may be gone

### How the loop continues

The intended controller loop is:

1. user request bootstraps the terminal chat
2. AI emits one plan / need-input / finished block
3. user approves, rejects, or answers
4. controller sends structured execution or rejection feedback back into the bound session
5. AI emits the next block
6. artifact sync freezes snapshots around those milestones and republishes the timeline

This loop is why terminal chat is implemented as a session-bound protocol layered on top of the live terminal rather than as raw shell I/O alone.

### Transcript cleanup for cards

`api/terminal-transcript.ts` contains transcript sanitization and timeline assembly helpers.

Notable cleanup behavior:

- strips ANSI OSC/CSI/control sequences
- applies backspace corrections
- removes transient prompt artifacts
- compresses blank-line noise

`buildTerminalTimelineEntries(...)` then interleaves snapshots and AI message cards by message key and sequence.

## Frontend Implementation

### Transport layer

The terminal pane does not talk to `fetch` and `EventSource` directly. It uses the shared transport API:

- `web/api.ts`
- `web/transport/local.ts`
- `web/transport/remote.ts`

For local mode, `subscribeTerminalStream(...)` opens:

- `/api/terminals/:terminalId/stream`
- `fromSeq` for replay
- `bootstrap=1` for initial snapshot/artifacts
- `clientId` so disconnect cleanup can release write ownership

Remote mode preserves the same browser-facing semantics by polling `GET /api/terminals/:terminalId/events` and translating batches into the same event stream.

### `TerminalView`

`web/components/terminal-view.tsx` is the main terminal pane component.

State owned by the component includes:

- live xterm instance and fit addon
- connection status
- running/stopped state
- current `writeOwnerId`
- full live output string
- frozen timeline entries
- read-only warning visibility
- local `seqRef`

Bootstrap flow:

1. Create a per-page terminal `clientId`.
2. Create the xterm instance and `FitAddon`.
3. Open xterm after `requestAnimationFrame` so layout measurements are valid.
4. Subscribe to the terminal stream with `bootstrap: true`.
5. Apply the bootstrap snapshot and artifact timeline.
6. If the terminal is unowned, claim write ownership.
7. If this client owns writes, send the current terminal size to the backend.

Incremental event handling:

- `output` appends chunk text
- `state` toggles running/stopped
- `reset` replaces the whole output buffer
- `ownership` updates read-only state
- `artifacts` replaces timeline entries

The component ignores stale events by comparing `event.seq` against `seqRef.current`.

### Input buffering

`web/terminal-session-client.ts` provides `createBufferedTerminalInputController(...)`.

This controller:

- queues xterm `onData` chunks
- serializes network writes through a promise chain
- blocks local writes when another client owns the terminal
- surfaces read-only attempts through a temporary warning

The input path is intentionally dumb at the browser layer. Ownership remains server-enforced.

### Fitting and resize

Terminal sizing uses:

- `@xterm/addon-fit`
- `web/terminal-render.ts`
- a `ResizeObserver`

When the container changes size:

1. `fitAddon.fit()` recomputes cols/rows.
2. If the size changed, the visible terminal may replay rendered output into xterm.
3. If this client owns writes, the new cols/rows are posted to the backend.

Only the write owner may resize. That keeps the server-side PTY dimensions authoritative and avoids tab fights.

### Restart behavior

Restart from the UI calls `POST /restart`.

Frontend behavior after restart:

- clear live output through the returned snapshot
- optionally auto-reclaim write ownership when the terminal was previously unowned or already owned by this client
- refit and resend size if ownership was recovered

The auto-reclaim policy lives in `web/terminal-write-ownership.ts`.

### Timeline rendering inside the pane

The pane combines three render modes:

1. live terminal output rendered by xterm
2. frozen snapshots rendered by `TerminalSnapshotBlock`
3. embedded message cards rendered by `MessageBlock`

`TerminalSnapshotBlock` renders serialized snapshots in a separate read-only xterm instance. It measures row height and content width dynamically so snapshots can clamp their viewport height while still allowing overflow scroll when needed.

The result is a mixed timeline:

- live shell at the top
- persisted AI cards and frozen snapshots below when present

This is why the pane needs both a live output buffer and a separate `timelineEntries` model.

## End-to-End Lifecycle

### Creating and using a terminal

1. The app creates a terminal through `POST /api/terminals`.
2. `LocalTerminalManager` starts a shell and stores a `TerminalInstance`.
3. The terminal list stream broadcasts the new summary.
4. `TerminalView` subscribes to the terminal stream and bootstraps from the current snapshot.
5. The page claims write ownership if available.
6. User keystrokes flow from xterm -> buffered controller -> `/input` -> PTY.
7. PTY output flows from process -> `TerminalInstance.publish(...)` -> SSE -> xterm.

### Binding a session

1. The app initializes or finds a Codex session for the selected terminal.
2. The app calls `POST /api/terminals/:terminalId/binding`.
3. Binding metadata is persisted on disk.
4. Session watcher updates trigger artifact sync.
5. `TerminalView` receives `artifacts` events and renders timeline cards/snapshots.

### Reconnect and replay

1. Client reconnects with `fromSeq`.
2. Server replays buffered events when possible.
3. If the replay window was missed, the server marks `requiresReset` or emits reset semantics.
4. Client redraws from the full snapshot and resumes incremental updates.

## Concurrency and Invariants

The terminal pane depends on these invariants:

1. Terminal read access is shared; write access is exclusive.
2. `seq` ordering is monotonic per terminal.
3. Reconnect must work from buffered replay or full reset.
4. Bound terminals survive reloads; unbound stopped terminals do not.
5. Artifact sync must be safe when session files change outside the current browser page.
6. Browser local mode and remote mode must expose equivalent terminal semantics.

Any change to the pane should be evaluated against those rules first.

## Extension Guidance

If you add features to the terminal pane, keep the following boundaries:

- Put process and concurrency logic in `api/local-terminal.ts`, not in React.
- Keep browser transport semantics identical between `web/transport/local.ts` and `web/transport/remote.ts`.
- Preserve server-side ownership enforcement even if the UI becomes more sophisticated.
- Add new timeline content as persisted artifact block types instead of ephemeral client-only state.
- Preserve `seq`-based replay compatibility for reconnecting clients.
- Treat the server-side snapshot format as durable data once it is persisted.

## Relevant Files

- `web/app/codex-deck-app.tsx`
- `web/components/terminal-view.tsx`
- `web/components/terminal-snapshot-block.tsx`
- `web/terminal-session-client.ts`
- `web/terminal-render.ts`
- `web/terminal-write-ownership.ts`
- `web/transport/local.ts`
- `web/transport/remote.ts`
- `api/server/terminal-routes.ts`
- `api/local-terminal.ts`
- `api/terminal-bindings.ts`
- `api/terminal-state.ts`
- `api/terminal-session-sync.ts`
- `api/terminal-session-store.ts`
- `api/terminal-snapshot.ts`
- `api/terminal-transcript.ts`
- `api/storage/runtime.ts`
