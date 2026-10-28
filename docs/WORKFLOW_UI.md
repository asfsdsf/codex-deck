# Workflow UI Command Mapping

This document records the current button-to-command mapping for the Workflow pane in the codex-deck web UI.

## Notes

- Workflow chat composers offer service-tier choices from the selected model catalog. Choices honor upstream feature and policy gates, reset when the model or Codex home changes, and apply to workflow chat sends and bootstrap messages.

- The Workflow pane uses the same browser-side local/remote transport abstraction as the rest of the app, so browsing workflows, opening logs, and invoking actions work in both local and remote mode.
- Workflow list, daemon status, and selected workflow detail all auto-refresh through the shared local/remote transport subscriptions.
- Workflow follow-up refreshes are targeted: workflow mutations and daemon-side workflow summary changes wake the existing workflow list and selected-detail subscriptions immediately, so new scheduler/session/thread state shows up in the selected workflow viewport without waiting for a manual reselect.
- In the left Workflow pane, `Refresh` lives on the search row and `New Workflow` uses the adjacent project-path input as the workflow project root.
- `New Workflow` now opens a lightweight ID prompt modal.
- The prompt validates workflow IDs before submit and creates an empty workflow draft (`tasks: []`) from that ID through the backend's native workflow-file writer; it does not require the `codex-deck-flow` skill to be installed.
- In the main Workflow viewport header, `Chat in session` and `Stop All` are exposed; merge actions are not exposed there.
- The main Workflow viewport header no longer exposes `Validate` or `Trigger`; those commands are still available through workflow control flows outside that header.
- In the shared main-content header, the workflow subtitle project name is now clickable and copies the full workflow `projectRoot` to the clipboard; the equivalent project-name labels in the Terminal and Codex headers behave the same way.
- In the main Workflow viewport, a `Latest session message` box now appears directly above the `Overview`, `Tasks`, `History`, `Logs`, `Control`, and `Raw JSON` buttons and reuses the same `MessageBlock` rendering path and important-message selection rules as chat-mode workflow creation.
- The main Workflow viewport now has the same bottom composer shell as the Codex pane, including the `Plan` toggle, model/effort controls, context indicator, attachment button, and message input.
- The shared bottom composer (Codex, Terminal, and Workflow tabs) has a translate button next to the attachment button: it translates the draft from the user language (Chinese) to the LLM language (English) via `POST /api/translate`, shows translated text incrementally as the backend produces output, and toggles back to the original draft on a second click; editing the draft or sending it clears the translation state. A translation failure restores the original draft.
- In the main Workflow viewport bottom composer, `Send` sends the drafted message to `workflow.boundSession` without leaving the Workflow pane.
- When the workflow already has `workflow.boundSession`, the main Workflow viewport bottom composer now exposes the full session slash-command set instead of the old `/model`, `/plan`, `/collab` subset.
- In the bound Workflow composer, slash commands keep the same behavior as the Codex session composer, including commands that switch to Codex view or open the right pane.
- When a workflow has no `workflow.boundSession`, the bottom composer primary action changes from `Send` to `Init`; `Init` creates or reuses the workflow chat session, binds it, and stays on the Workflow pane instead of navigating into the session.
- When a workflow has no `workflow.boundSession`, both `Chat in session` and `Init` first inspect workflow-project skills for `codex-deck-flow`; if it is missing from both project-local and global scopes, a floating modal asks whether to install it locally, install it globally, or cancel initialization.
- When `Init` is triggered from the Workflow bottom composer with draft content, the first bootstrap message now includes a handoff hint and embeds the draft as the user's first request, so a second manual `Send` is not required.
- When a workflow has no `workflow.boundSession`, slash-command suggestions are hidden and `/...` input is treated as ordinary draft text until the workflow is initialized.
- In the Codex message viewport, when the selected session matches `workflow.boundSession`, a `Workflow` button appears under the header at the top-left and jumps to the first matching workflow.
- In the left Codex session list, workflow-linked sessions show an inline role label before the title: `scheduler`, `flow task`, or `flow chat`.
- In the main Workflow viewport header, the right-pane toggle is UI-only and does not invoke `codex-deck-flow`.
- In Workflow view, the right pane now reads diff/file-tree/file-content/skills from the selected workflow's `projectRoot` even when no workflow session is bound.
- In the Workflow `History` tab, entries render as structured cards with status badges, task/session jump buttons, and syntax-highlighted JSON blocks for payloads and remaining details instead of a single raw event dump.
- In the Workflow `Tasks` tab, long text blocks inside Scheduler and Task cards (for example scheduler reason/prompt and task summary/failure) now render as markdown (matching the Codex message style), use a capped max height, and become internally scrollable to avoid oversized cards on desktop/mobile.
- Browser console tracing now logs only daemon-owned Codex runtime commands (`codex exec` and resume-helper turns) as workflow history updates arrive. The global toggle is `window.__CODEX_DECK_DAEMON_COMMAND_LOG_ENABLED__` and defaults to `true`; set it to `false` to silence these console entries.
- In the Workflow `Raw JSON` tab, the workflow document is shown as syntax-highlighted exact JSON with visual line wrapping and fallback scrolling so long documents stay readable on desktop and mobile.
- Some buttons map to codex-deck-flow script commands.
- Some buttons are UI-only navigation or read-only backend fetches and do not invoke `codex-deck-flow` scripts.

## Buttons that map to codex-deck-flow commands

### Launch task

- UI button: `Launch task`
- Behavior note: if the selected task reuses a branch from a finished dependency predecessor in the same workflow, codex-deck-flow now removes the predecessor worktree first and then reattaches that branch to the new task worktree. Unordered shared-branch task layouts remain invalid and fail validation.
- Skill script command:
  ```bash
  .claude/skills/codex-deck-flow/scripts/run.sh launch-task --workflow <workflow-path> --task-id <task-id>
  ```
- Underlying shell / Python target:
  ```bash
  python3 .claude/skills/codex-deck-flow/scripts/workflow.py launch-task --workflow <workflow-path> --task-id <task-id>
  ```

### Start daemon

- UI button: `Start daemon`
- Skill script command:
  ```bash
  .claude/skills/codex-deck-flow/scripts/run.sh daemon-start
  ```
- Underlying shell / Python target:
  ```bash
  python3 .claude/skills/codex-deck-flow/scripts/daemon.py start --project-root <project-root>
  ```

### Stop daemon

- UI button: `Stop daemon`
- Skill script command:
  ```bash
  .claude/skills/codex-deck-flow/scripts/run.sh daemon-stop
  ```
- Underlying shell / Python target:
  ```bash
  python3 .claude/skills/codex-deck-flow/scripts/daemon.py stop --project-root <project-root>
  ```

### Send control message

- UI button: `Send control message`
- Skill script command:
  ```bash
  .claude/skills/codex-deck-flow/scripts/run.sh daemon-send --workflow <workflow-path> --type <message-type> --reason <reason> --payload-json <json>
  ```
- Underlying shell / Python target:
  ```bash
  python3 .claude/skills/codex-deck-flow/scripts/daemon_send.py --project-root <project-root> --workflow <workflow-path> --type <message-type> --reason <reason> --payload-json <json>
  ```

### Stop All

- UI button: `Stop All`
- Behavior:
  - Stops daemon-started processes for the selected workflow only.
  - Covers active scheduler command execution and running task-runner processes for that workflow.
  - Applies dangling-turn repair to any known session IDs associated with the stopped processes.
  - The header shows a hint with the stopped process count after the action completes.
- Skill script command:
  ```bash
  .claude/skills/codex-deck-flow/scripts/run.sh stop-workflow-processes --workflow [absolute path to workflow JSON file]
  ```
- Underlying shell / Python target:
  ```bash
  python3 .claude/skills/codex-deck-flow/scripts/daemon_send.py --project-root [absolute project root path] --workflow [absolute path to workflow JSON file] --type stop-workflow-processes
  ```

## Buttons that do not map to codex-deck-flow commands

### Open session

- UI button: `Open session`
- Behavior: switch the app to Codex mode and open the related session
- No `codex-deck-flow` script command is invoked

### New Workflow

- UI button: `New Workflow`
- Adjacent UI input: `Project path`
- Prompt behavior:
  - Opens an ID prompt modal.
  - Validates the entered ID locally. Allowed characters are letters, numbers, `-`, `_`; spaces and other special characters are rejected.
  - On submit, creates an empty workflow draft by calling the workflow create API with:
    - `workflowId = [entered id]`
    - `title = [entered id]`
    - `request = "Empty workflow scaffold"`
    - `tasksJson = []`
  - Uses the adjacent `Project path` as `projectRoot`.
  - The backend writes the workflow JSON, lock file, and registry entry directly; no `codex-deck-flow` skill command is invoked.

### Chat in session

- UI button: `Chat in session`
- Behavior when the workflow already has `workflow.boundSession`: switch the app to Codex mode and open that bound session without changing the current Codex project filter selection
- Behavior when the workflow is not yet bound:
  1. Inspect workflow-project skills for `codex-deck-flow`
  2. If `codex-deck-flow` is missing from both project-local and global scopes, show a floating prompt with `Install locally`, `Install globally`, and `Cancel init`
  3. If the user cancels, stop without creating or binding a session
  4. Create a new Codex session in the workflow project root
  5. Prefix the bootstrap message with the chosen `$skill-installer` install request when the prompt was used
  6. Send this bootstrap message to the new session:
     ```text
     (Use skill codex-deck-flow) The workflow ID is [workflow ID] and the project path is [workflow project path]. Please read the information of the workflow and do not do other things.
     ```
  7. Persist the new session ID to `workflow.boundSession` in the workflow JSON
  8. Switch the app to Codex mode and open the new bound session without changing the current Codex project filter selection
- Install prefix when `Install locally` is chosen:
  ```text
  $skill-installer install the codex-deck-flow skill from GitHub repo asfsdsf/codex-deck, branch main, path skills/codex-deck-flow, into the appropriate project-local skills destination that you infer automatically from the local context. Do not install globally. Then do following:
  ```
- Install prefix when `Install globally` is chosen:
  ```text
  $skill-installer install the codex-deck-flow skill globally from GitHub repo asfsdsf/codex-deck, branch main, path skills/codex-deck-flow, using the default global Codex skills directory. Then do following:
  ```
- No `codex-deck-flow` script command is invoked directly by the UI button; it instructs the created Codex session to use the skill in the bootstrap prompt

### Diff guide command

- `/codex-deck-diff` and its alias `/ai-diff` both appear in the slash-command list and accept an optional multiline request in session, bound Workflow, and bound Terminal composers. Selecting either command leaves room to enter the request. Enter and the primary Run button dispatch the command; an unbound composer treats slash text as its normal initial request.
- Before forking, the CLI checks the source project, Git/Python tooling, and skill availability. A missing skill offers **Install locally / Install globally / Cancel**. Cancel preserves the draft and creates no fork. Disabled skills require enabling in Skills settings.
- The command forks the active bound session with its conversation history, opens the persistent fork, and sends the diff-skill bootstrap in default execution mode. When Codex stores inherited history as parent references, conversation loading follows those references up to the captured fork point, including nested forks. Inherited messages are read-only; later parent messages are excluded. Pagination and live updates continue from the inherited history in both local and remote mode. The parent mode and active turn remain intact; the fork receives no workflow or terminal binding.
- Artifacts are owned by the fork under the active CLI's `$CODEX_HOME/codex-deck/diff/sessions/<forkSessionId>/`. Persisted metadata records the parent session; the bootstrap supplies explicit paths for `snapshot.json`, `guide.json`, and `diff-tour.html`, and requires capture with `--omit-source`. This applies to both slash-command aliases and retries. The HTML is published after a successful snapshot-based build.
- Readiness requires valid guide/snapshot JSON with matching comparison metadata and complete HTML. Source-free snapshots retain Git identities, diff hunks, newline flags, and hidden-range descriptors, with no compressed source blobs or hidden unchanged text. Artifact size alone does not make a guide unavailable. Only the guide summary and HTML travel to the browser.
- Diff sessions show a **diff guide** text badge using the same session-list style as Terminal and Workflow roles. The conversation has a sticky **Origin session** button at the top left that opens the source/parent session, and a **Diff guide** button at the top right that opens a responsive full-screen viewer with Close, Refresh, and generation/error states. Both buttons remain visible when scrolling, truncate long labels on narrow screens, and follow the app theme. Origin navigation uses the normal session selection checks, including sessions outside the current list; a missing source shows the existing unavailable-session message. The saved parent relation survives reloads and works in local and remote mode. Explicit generation retries reuse the fork. An empty diff produces an explanation in the conversation.
- Embedded source operations load through the active CLI's origin repository. Baseline source comes from the recorded commit; current-side source is reconstructed by applying the captured diff, so later working-tree edits and moved branch/tag names do not affect it. Full-file views, hidden context, definition previews, references, transition citations, and review-comment validation/export use the scoped, paginated source API in both local and remote mode. Missing commits and invalid reconstruction show retryable errors without falling back to another revision or embedded source. Source responses are bound to the sandboxed frame and discarded after navigation, refresh, or close. Standalone source-free HTML displays the captured diff and authored excerpts; complete-source actions report that a provider is required. Existing earlier snapshot formats require regeneration.
- The embedded viewer adds translation icons to each left-pane step title, the selected step's middle-pane heading and main description, and each code-change note's title and description. Icons sit at the top right inside their blocks, leaving note bodies and subsequent title lines the full available width. Translation controls remain separate buttons so their clicks do not activate the surrounding navigation or note. Each icon independently toggles English → Chinese and back, reuses the message translation cache, and retains its state while navigating steps. The **Auto translate** toggle beside Refresh starts off. Enabling it translates all sidebar step titles and the current step's heading, main description, and notes; entering another step automatically translates its descriptions, including when revisiting a step. Individual icons can still show originals: description overrides last until leaving the step, and sidebar overrides remain during navigation. Disabling auto translation restores all originals, clears queued requests, and prevents delayed results from changing the displayed text. Bulk requests are limited to four groups at a time, prioritizing the selected step. Partial translations appear immediately in each field while individual controls remain disabled and show loading. Failures restore the original text and allow retry; only successful complete translations enter the cache. Translation clicks preserve step selection and highlighted lines. On mobile, the selected step's title toggle sits inside the step selector frame, before its dropdown arrow, and all translation controls retain 44-pixel touch targets. This app-only enhancement streams accumulated output over local SSE and encrypted polling in remote mode. At most four translation requests run across the page at once; the skill, saved guide JSON/HTML, source code, paths, and line numbers stay unchanged. Refreshing keeps the auto-translate setting; reopening the viewer starts with auto translation off and original text. Cached translations remain available until page reload.
- Deleting a diff session offers **Cancel**, **Delete session only**, and **Delete session + diff guide**. Deleting only the session retains its saved guide files in the original artifact directory, including the standalone HTML; choosing both removes that directory. The source/parent session is preserved. The dialog wraps its actions on narrow screens and disables them while deletion is running.
- Guide HTML travels through the app's JSON transport in both local and encrypted remote mode and runs inside an isolated iframe. Comment export remains available when embedded browser storage is unavailable. Persistent roles and readiness recover after reload/reconnect/tab wake and update across clients. Archiving preserves artifacts. Session deletion defaults to artifact cleanup for existing API callers; `deleteDiffGuide=false` explicitly retains the files in both local and remote mode.

### Review and side sessions

- `/review` opens the review target dialog and calls native `review/start` with `delivery: "inline"`, matching Codex CLI. The review runs as a turn in the composer's bound conversation for both legacy and paginated threads. Deck tracks that conversation's running turn and uses Codex's native review output; Codex owns reviewer behavior and the `review_model` configuration. Deck does not create or fork a separate session for review. Shared app-server connections subscribe to the current thread before starting the review and re-subscribe after reconnecting. A thread-not-loaded response triggers a resume and one retry on the same thread; other RPC and connection failures remain visible.
- Sessions with a native review origin and `/side` sessions show **review** and **side** badges using the same session-list style as **diff guide**. Both reuse the sticky **Origin session** button in the conversation, with the same theme, narrow-screen layout, and session-availability checks. The side-session Return button and Side badge no longer appear in the top bar.
- Review badges and origin links are recognized only from Codex's native `session_meta.source` (`subagent: review`) and `parent_thread_id`. Starting an inline review does not label the current conversation as a separate review session or create Deck-specific markers or saved origin metadata. Native review child sessions use the same read-only detection whether created by Deck or Codex CLI, including SQLite-backed and compressed session listings through bounded metadata reads.
- Side origins are derived from the native fork parent (`forked_from_id` or `history_base.thread_id`) and the existing side-conversation boundary at the start of the fork's own user messages. Ordinary forks are not labeled as side sessions. No Deck origin markers are written or read for either review or side sessions. Badges and return navigation survive reloads and update across browser tabs through local SSE or encrypted remote polling; deleting a child preserves the source session.
- Review feedback wrapped in `<user_action>` and structured final review JSON render as review cards in conversations and latest-session previews. Cards show the summary, verdict when provided, finding count, priority labels, Markdown explanations, and file/line links that use the normal file viewer. **Original review** exposes the complete source payload; existing message copy, translation, and editing remain available. Cards follow the app theme and wrap on mobile. Incomplete, malformed, and unrelated messages retain their normal rendering.

### Native workflow commands

- `/mcp` opens MCP administration for the composer’s bound session (or global inventory without a session). It lists servers, tools and schemas, authentication, resources, and retained startup/OAuth status. OAuth returns an explicit authorization link; **Reload configuration** reloads the shared registry. Snapshots reconcile across tabs and encrypted remote polling.

- `/usage` opens account limits and reset times, credit balance, daily activity, and conversation credit/USD estimates when supplied by Codex. Missing capabilities show explicit availability messages. Reset redemption requires an in-dialog confirmation and retains its attempt ID across retries; account notifications and visible-page polling refresh every client.

- `/recap` generates a bounded catch-up in an ephemeral thread using the conversation model/provider, inherited permission restrictions, and disabled tools. The dialog shows preparation/generation, summary, next action, and failures. Concurrent requests for the same session share one job; results and progress reconcile across clients. Jobs time out, detach temporary threads, and remain available for the lifetime of the Deck process.

- `/export [file name]` opens a Markdown preview of the bound conversation’s complete available transcript. **Download Markdown** saves it through the browser, preserving message order, role/time/model details, summaries, tool calls/results, and image references. Refresh captures newer activity; the same conversation reader serves local and remote mode.

- `/experimental` discovers the host’s paginated feature catalog for the bound thread. Beta features are shown first, with an option to inspect other stages. Saving writes only changed feature keys through native config APIs and reads back effective settings; managed overrides remain visible. Running tasks retain their settings, and other clients refresh after saves. Removed/deprecated entries cannot be toggled.

- `/warnings` opens retained host and conversation warnings, configuration warnings, and deprecation notices. Up to 256 warnings are retained separately from tool progress for this Deck process. New warnings refresh every connected browser; reconnecting clients read the current snapshot. Details include category, timestamp, scope, and a redacted payload.
- `/debug-config` reads native effective configuration for the conversation working directory, the reported configuration-layer stack (including disabled reasons), value origins, and managed requirements. It preserves partial results on unsupported APIs and explicitly reports when requirement sources are not exposed by the connected server. Config credentials, environment/header values, and URL authentication are redacted before reaching the browser. Conversation turn overrides are separate from this host configuration view. Both views use the same local and remote browser transport, support manual refresh, and refresh on relevant shared changes and reconnects.
- Live steering: while a turn runs and the session composer has a draft, the primary button reads **Steer** and Enter delivers the draft into the running turn with `turn/steer`, using the turn the browser saw as the `expectedTurnId` precondition (a stale id is retried once with the server-reported turn; a turn that already finished starts a new turn instead). A hint row above the textarea offers **Queue** (also Tab) to hold the message for after the turn and **Interrupt & send** to stop the turn and send the draft as a new turn. Review and compact turns reject steering, so those messages are queued. Steered messages show “Steering — submitted after the next tool call” until Codex records them.
- Shared message queue: queued messages are stored by the app-server (`thread/queue/*`), so every tab, device, and reconnecting client sees the same queue. Queued items appear at the end of the conversation with **Send now**, **Edit**, up/down reorder, and **Cancel**. The app-server starts the next item itself when a turn completes, so browsers never auto-start queued items and several connected clients cannot double-send. Interrupting a turn pauses the queue until a later turn completes; **Send now** interrupts a running turn and starts that item immediately. `thread/queue/changed` notifications, reconnect snapshots, and page visibility refetch the queue in local and remote mode. App-servers without the queue API fall back to the browser-local queue (send now and cancel only).
- Structured output: the `{ }` button in the session composer toolbar opens a JSON-schema editor. **Attach** validates that the text is a JSON object (up to 64 KB) and shows an “Output schema: …” chip above the textarea; the next turn the message starts sends it as `outputSchema` on `turn/start` (also accepted by `POST /api/codex/threads/:id/messages`, 400 unless a JSON object). The schema is cleared after a successful send. A turn already running cannot take a schema, so steering or queueing with one attached asks you to wait or use **Interrupt & send**.
- `/daybreak` checks the OpenAI provider, account type, effective Daybreak feature gates, and advertised per-model access programs. A selection uses native thread metadata and applies only to new turns; the send bridge revalidates the actual turn model and selects an advertised Daybreak or standard program. Missing eligibility never implies access, and disabling remains available when prior eligibility disappears. Selection changes refresh all clients.

### Workflow composer send/init

- UI location: bottom composer in the main Workflow viewport
- When the workflow already has `workflow.boundSession`:
  - Primary button: `Send`
  - Behavior: send the current composer contents to the bound session in place and keep the app in the Workflow viewport
  - Slash commands: same visible slash-command list and same command behavior as the Codex session composer
- When the workflow does not yet have `workflow.boundSession`:
  - Primary button: `Init`
  - Behavior: same skill-check / optional install-prompt / session creation / bootstrap / bind flow as `Chat in session`, but the app stays in the Workflow viewport instead of switching to Codex mode
  - Draft handoff: if the composer has text and/or image attachments, `Init` sends them in the first bootstrap turn by appending a handoff hint plus a `User first request` block (and includes attached images in that same first turn)
  - Slash commands: hidden until a bound session exists; `/...` is treated as normal draft text
- No `codex-deck-flow` script command is invoked directly by the UI button; it reuses the same Codex bootstrap prompt and workflow binding flow described above

### Workflow

- UI button: `Workflow`
- Location: Codex message viewport, under the session header at the top-left
- Behavior: if the selected session matches one or more workflows by `workflow.boundSession`, show the button and switch the app to the first matching workflow when clicked
- No `codex-deck-flow` script command is invoked

### Scheduler log

- UI button: `Scheduler log`
- Behavior: load the scheduler log through the app's active browser transport (local or remote)
- No `codex-deck-flow` script command is invoked

### Daemon log

- UI button: `Daemon log`
- Behavior: load the daemon log through the app's active browser transport (local or remote)
- No `codex-deck-flow` script command is invoked

### Right pane toggle

- UI button: right-edge toggle in the main Workflow viewport header
- Behavior: expands or collapses the shared right pane for the selected workflow project
- No `codex-deck-flow` script command is invoked

Choosing Default speed in workflow chat explicitly restores the current configured
or catalog default, including after a different tier was used for an earlier turn.

The Hooks pane also shows recent execution status and output for session targets.
These runs are retained by the current Deck process (up to 100 per thread), shared
across browsers, and refreshed after reconnecting. Workflow project targets retain
their hook configuration view; execution belongs to each task's session.

For session targets, Terminal flow includes the upstream active background-command
list above saved terminal history. Commands can be stopped individually or all at
once. The active list refreshes while visible and after reconnects; older Codex
versions can still display saved history when the listing API is unavailable.
Workflow project targets do not mount thread runtime panels or poll thread-only
APIs. Select a task's session to inspect its running commands and hook executions.
