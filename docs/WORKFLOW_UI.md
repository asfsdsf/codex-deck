# Workflow UI Command Mapping

This document records the current button-to-command mapping for the Workflow pane in the codex-deck web UI.

## Notes

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
