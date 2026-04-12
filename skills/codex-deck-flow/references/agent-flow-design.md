# Agent Flow Design

## Summary

This design defines a persistent workflow skill for standalone multi-agent execution in git-based coding repositories with these fixed constraints:

- One workflow is persisted in one JSON file at `./.codex-deck/<workflow-id>.json`.
- Workflow IDs are unique only within one project root. The same ID may exist in another project root, but sanitization collisions within one project root are rejected at create time.
- Lightweight workflow registry records are mirrored under `[codex home]/codex-deck/workflows/` for cross-project discovery.
- Per-session workflow lookup records are mirrored under `[codex home]/codex-deck/workflows/session-index/` so a session can be resolved back to its workflow quickly.
- The workflow graph only encodes task dependencies (`dependsOn`).
- A runtime-only scheduler state exists in `scheduler` and is not recorded as a task item.
- A user-global codex-deck-flow daemon owns orchestration and survives beyond the interactive skill invocation.
- The daemon preserves scheduler continuity through the same non-interactive app-server-backed continuation model used by `scripts/codex_resume_noninteractive.py`.
- First scheduler pass may still be created with `codex exec --sandbox danger-full-access`; follow-up daemon-owned continuity should use the helper-based non-interactive resume path, which launches `codex --sandbox danger-full-access app-server` and starts turns with the same sandbox policy.
- Worker tasks run through `codex exec --sandbox danger-full-access` in isolated `git worktree` directories.
- Daemon-owned Codex runtime commands (`codex exec` and scheduler resume-helper turns) are recorded as workflow history events (`daemon_command_executed`) for browser-side tracing.
- The daemon supports immediate workflow-scoped process cancellation (`stop-workflow-processes`) that terminates daemon-started task/scheduler process groups, applies dangling-turn repair to stopped sessions with known IDs, and records the stop/fix results in workflow history.
- Each worker task writes its `sessionId` into its task block when execution starts.
- Task completion/failure is reported back to the daemon, and the daemon owns all follow-up scheduling.
- If scheduler is triggered while already running, only one pending trigger is retained.
- Workflow scheduling stays inside the codex-deck-flow command surface instead of ad-hoc orchestration.
- Scheduler-only task mutation guidance lives in `references/scheduler.md`, and non-scheduler roles should not load it to keep context small.
- Operator command sequences, authoring rules, and runbooks are canonicalized in topic references under `references/` (`commands.md`, `authoring.md`, `runbooks.md`, `guidance-routing.md`).
- Project-specific scheduler notation/rule files live under `./.codex-deck/scheduler/`, where `guide.md` is the index for all scheduler guidance markdown files.
- Project-specific workflow-task notation/rule files live under `./.codex-deck/flow_tasks/`, where `guide.md` is the index for all workflow-task guidance markdown files.
- Rule routing should place orchestration rules in `./.codex-deck/scheduler/` and worker-execution rules in `./.codex-deck/flow_tasks/`.
- `guide.md` index entries should stay compact one-line bullets (`- <file>.md: <short summary>`), with details kept in referenced files.
- Skill tool allowlisting should cover `.claude/skills/codex-deck-flow/scripts/` entrypoints to avoid repeated script-execution approval prompts during codex-deck-flow operations.

The skill is implemented under `.claude/skills/codex-deck-flow/` and acts as a control client: it starts the shared daemon if needed, sends a control message, and stops. The daemon is the ongoing orchestrator.

## Roles

This section captures the exact natural-language prompt templates used between the runtime roles. Dynamic parts are shown as bracketed placeholders with explicit meaning.

### llm

| trigger                                                                   | content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | destination |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| The Codex Deck Flow agent is activated for the chat turn                       | `If the user explicitly mentions $codex-deck-flow, activate codex-deck-flow orchestration immediately and stay inside the workflow system. If the current session does not already know an existing workflow path and the user gives project root plus workflow ID, begin with resolve-workflow, then validate, reconcile, and status before making scheduling decisions. If the current session already knows the workflow path, reuse it instead of resolving again. If the user gives an existing workflow path, begin with validate, reconcile, and status. For a new workflow, begin with create, then validate, then show/status, and present tasks for approval before trigger. If the user explicitly includes Strict task creating mode, keep the normal create/validate/show flow, append <codex-deck-flow>Question<codex-deck-flow/> to clarification questions, append <codex-deck-flow>Request approve:workflow-file-name.json<codex-deck-flow/> to the approval request using only the workflow JSON file name in place of workflow-file-name.json, and if approval includes workflow reuse data for the existing draft, do not create the workflow again. Keep merge explicit and never apply merge unless the user asked.` | llm         |
| The user approves execution and the skill hands control to the daemon     | `Please enqueue this workflow for execution now. Workflow file: [Absolute path to the workflow JSON file that should be scheduled]. Reason: [Why the workflow is being triggered, such as user approval after review].`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | daemon      |
| The user asks the skill to send an explicit control message to the daemon | `Please store this operator control message in the workflow and wake the scheduler. Workflow file: [Absolute path to the workflow JSON file that should receive the control message]. Control message: [Structured operator instruction that should later appear under Pending control messages in the scheduler prompt]. If the scheduler is already running, keep the message for the pending rerun instead of starting an overlapping turn.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | daemon      |

### daemon

| trigger                                       | content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | destination    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| The daemon starts or resumes a scheduler turn | `You are the runtime scheduler for this workflow. Start each turn by refreshing workflow state: reconcile dead runners, apply stop-signal pruning, and recompute workflow status. Then inspect status and ready tasks before making scheduling decisions. Process any active control messages from the operator before deciding whether to edit workflow state or launch more work. Use only the codex-deck-flow command surface provided in this prompt for orchestration. Launch tasks only when dependencies are satisfied, branch conflicts are avoided, and workflow capacity allows more running tasks. Keep merge explicit; do not merge unless the user explicitly asked. Before finishing the turn, run validate and ensure it succeeds.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | scheduler task |
| The daemon starts or resumes a scheduler turn | `Skill command path: [Absolute path to run.sh inside .claude/skills/codex-deck-flow/scripts]`<br>`Use only these commands for workflow control in this turn:`<br>`- [Absolute path to run.sh inside .claude/skills/codex-deck-flow/scripts] validate --workflow [Absolute path to the workflow JSON file for this run]`<br>`- [Absolute path to run.sh inside .claude/skills/codex-deck-flow/scripts] ready-tasks --workflow [Absolute path to the workflow JSON file for this run] --json`<br>`- [Absolute path to run.sh inside .claude/skills/codex-deck-flow/scripts] launch-task --workflow [Absolute path to the workflow JSON file for this run] --task-id [Task id selected from ready-tasks output]`<br>`- [Absolute path to run.sh inside .claude/skills/codex-deck-flow/scripts] reconcile --workflow [Absolute path to the workflow JSON file for this run]`<br>`- [Absolute path to run.sh inside .claude/skills/codex-deck-flow/scripts] show --workflow [Absolute path to the workflow JSON file for this run]`<br>`- [Absolute path to run.sh inside .claude/skills/codex-deck-flow/scripts] status --workflow [Absolute path to the workflow JSON file for this run]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | scheduler task |
| The daemon starts or resumes a scheduler turn | `Trigger reason: [Reason passed into compose_scheduler_prompt such as user trigger, daemon trigger, or task-finished]`<br>`Workflow file: [Absolute path to the workflow JSON file being orchestrated]`<br>`Workflow: [Workflow id from workflow.id] ([Workflow status from workflow.status])`<br>`Target branch: [Target branch name from workflow.targetBranch]`<br>`User request: [Original workflow request text from workflow.request]`<br>`Max parallel: [Maximum number of workflow tasks allowed to run concurrently from settings.maxParallel]`<br>`Scheduler session: [Last resumed session/thread id if available, or -]`<br>`Scheduler thread: [scheduler.threadId or -] turn=[scheduler.lastTurnId or -] status=[scheduler.lastTurnStatus or -]`<br>`Running tasks now: [Comma-separated ids of tasks whose status is running, or - if none]`<br>`Ready tasks now: [Comma-separated ids of dependency-ready tasks, or - if none]`<br>`Current tasks:`<br>`[One line per task in this exact format: - [task id]: status=[task status] deps=[comma-separated dependency ids or -] session=[session id or -] branch=[branch name or -]]`<br>`Recent task outcomes:`<br>`[Up to five recent completed/failed/cancelled task lines in this exact format: - [task id]: status=[task status] commit=[result commit or -] noOp=[yes or no] stopPending=[yes or no] failure=[failure reason or -] summary=[single-line truncated summary or -]]`<br>`Pending control messages:`<br>`[Up to five recent control message lines in this exact format: - request=[request id or -] type=[message type or -] payload=[JSON payload], or - (none)]` | scheduler task |

### scheduler task

Scheduler-only reference:

- `references/scheduler.md` is for the scheduler task role only.
- scheduler task should read `./.codex-deck/scheduler/guide.md` and then read every markdown file indexed there.
- `llm`, `daemon`, and workflow worker tasks should not load `./.codex-deck/scheduler/` guidance files.
- scheduler task should not load `./.codex-deck/flow_tasks/` guidance files.
- scheduler `guide.md` should avoid verbose index structure; use compact one-line entries.

| trigger                                                   | content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | destination    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| A new workflow is created without an explicit task prompt | `Workflow context:`<br>`- Overall request: [Original workflow request text from workflow.request]`<br>`- Assigned task: [Task name generated for this task, such as task-1 or a user-authored task id]`<br><br>`Execution contract:`<br>`- Work only on this assigned task in the provided branch/worktree.`<br>`- Avoid redoing sibling tasks or broad workflow orchestration.`<br>`- Run relevant tests/build checks for your changes.`<br>`- Commit your final changes with a clear commit message if you make code changes.`<br>`- In your final summary, explain what changed in user-facing terms.`<br>`- If this is a feature, explain how a user can use the project to see it.`<br>`- If this is a bug fix, explain how to reproduce the old problem and how to verify the fix.`<br>`- If this is an internal/refactor change, explain what behavior should remain the same and what to inspect.`<br>`- If no code changes are required, clearly state \`no-op\` in the final summary.`<br>`- Only include \`[codex-deck:stop-pending]\` in the final summary if completing this task truly makes remaining pending tasks unnecessary.` | workflow tasks |
| A task runner launches a workflow task                    | `[The stored task prompt from tasks[i].prompt.]`<br>`Workflow invariants:`<br>`- Work only in the provided branch/worktree.`<br>`- Run relevant tests/build checks for your changes.`<br>`- If you make code changes, commit your final changes with a clear commit message.`<br>`- If no code changes are required, clearly state \`no-op\` in the final summary.`<br>`- Only include \`[codex-deck:stop-pending]\` in the final summary if completing this task truly makes remaining pending tasks unnecessary.`<br>`- In the final summary, explain what changed in user-facing terms and how to verify or see it.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | workflow tasks |

### workflow tasks

This role does not send another AI prompt in the current implementation. It reports compact machine-readable task outcomes back to the daemon and also preserves a human-readable summary.

Workflow-task-only reference:

- workflow tasks should read `./.codex-deck/flow_tasks/guide.md` and then read every markdown file indexed there before implementation work.
- `llm` (flow chat session/main agent), `daemon`, and scheduler task should not load `./.codex-deck/flow_tasks/` guidance files.
- workflow-task `guide.md` should avoid verbose index structure; use compact one-line entries.

| trigger                                                              | content                                                                        | destination |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------- |
| The task finishes                                                    | `payload.summary=[final summary text extracted from the worker Codex session]` | daemon      |
| The task finishes with no code change required                       | `payload.noOp=true`                                                            | daemon      |
| The task finishes and determines remaining pending tasks should stop | `payload.stopPending=true`                                                     | daemon      |
| Backward-compatible summary markers still present in worker text     | `no-op` / `[codex-deck:stop-pending]`                                          | daemon      |

## Strict task creating mode protocol

When the user explicitly includes `Strict task creating mode`, the skill keeps the usual create-first workflow but uses an additional chat/UI protocol:

- clarification questions must end with `<codex-deck-flow>Question<codex-deck-flow/>`
- approval requests must end with `<codex-deck-flow>Request approve:workflow-file-name.json<codex-deck-flow/>`
- replace `workflow-file-name.json` with the created workflow JSON file name only
- do not add brackets around the workflow file name token
- once the user approves, strict task creating mode ends
- if the approval message includes workflow reuse data for the existing draft, the skill must reuse that workflow and must not run `create` again
- the approval request should be interpreted from the assistant output for the current workflow-authoring turn, not from older assistant turns in the same chat

Recommended approval handoff payload from the UI:

```text
Approve. The workflow draft already exists. Do not create it again. Reuse the existing workflow and continue from it.

Workflow data:
{"workflowPath":"[absolute workflow json path]","workflowFileName":"[workflow json file name]","workflowId":"[workflow id]","projectRoot":"[absolute project root]","boundSessionId":"[chat session id bound by the UI]"}
```

## Workflow File Contract

Path:

- `./.codex-deck/<workflow-id>.json`

Top-level shape:

```json
{
  "workflow": {
    "id": "feature-delivery",
    "title": "Feature Delivery",
    "createdAt": "2026-03-21T00:00:00Z",
    "updatedAt": "2026-03-21T00:00:00Z",
    "status": "draft",
    "targetBranch": "dev",
    "projectRoot": "/abs/project/path",
    "request": "Implement 5 related product tasks"
  },
  "scheduler": {
    "running": false,
    "pendingTrigger": false,
    "lastRunAt": null,
    "lastSessionId": null,
    "lastReason": null,
    "threadId": "thread-123",
    "lastTurnId": "turn-456",
    "lastTurnStatus": "completed",
    "controllerMode": "daemon",
    "controller": {
      "daemonPid": 12345,
      "daemonStartedAt": "2026-03-21T00:00:00Z",
      "lastHeartbeatAt": "2026-03-21T00:00:30Z",
      "lastEnqueueAt": "2026-03-21T00:00:15Z",
      "lastDequeuedAt": "2026-03-21T00:00:16Z",
      "activeRequestId": "req-123",
      "appServerStartedAt": "2026-03-21T00:00:00Z"
    }
  },
  "settings": {
    "codexHome": "/home/user/.codex",
    "maxParallel": 2,
    "mergePolicy": "integration-branch"
  },
  "tasks": [
    {
      "id": "task-1",
      "name": "task-1",
      "prompt": "...",
      "dependsOn": [],
      "status": "pending",
      "sessionId": null,
      "branchName": "flow/feature-delivery/task-1",
      "worktreePath": null,
      "baseCommit": null,
      "resultCommit": null,
      "startedAt": null,
      "finishedAt": null,
      "summary": null,
      "failureReason": null,
      "runnerPid": null
    }
  ],
  "history": []
}
```

Task `status` values:

- `pending`
- `running`
- `success`
- `failed`
- `cancelled`

Workflow `status` values:

- `draft`
- `running`
- `completed`
- `failed`
- `cancelled`

## Workflow Registry Contract

Registry path:

- `[codex home]/codex-deck/workflows/<registry-key>.json`

Purpose:

- expose lightweight workflow discovery metadata without replacing the canonical repo-local workflow JSON
- provide a stable `workflowPath` back to `./.codex-deck/<workflow-id>.json`
- summarize workflow/task status for cross-project listing UIs

Suggested contents:

- `key`
- `workflowPath`
- workflow summary fields (`id`, `title`, `status`, `projectRoot`, `targetBranch`, `updatedAt`)
  - include `boundSession` when the workflow is bound to a Codex session
- scheduler summary fields (`running`, `pendingTrigger`, `lastSessionId`, `threadId`, `lastReason`, `lastRunAt`, `lastTurnStatus`)
- task counts by status
- recent task outcome summaries

The registry should be updated whenever canonical workflow JSON is written, and existing project-local workflows may be backfilled into the registry on demand.

## Session Index Contract

Session index path:

- `[codex home]/codex-deck/workflows/session-index/<session-id>.json`

Purpose:

- provide fast workflow lookup starting from a Codex session id
- cover bound workflow sessions, scheduler sessions, and task sessions without scanning workflow files
- keep one record per session id

Suggested contents:

- `sessionId`
- `type`
  - `bound`
  - `scheduler`
  - `task`
- `workflowKey`
- `workflowId`
- `workflowTitle`
- `workflowPath`
- `projectRoot`
- `taskId`
  - present only for `task` entries; otherwise `null`
- `updatedAt`

Update rules:

- write session index records whenever canonical workflow JSON is written or when mirrored registry state is refreshed from canonical workflow JSON
- if the same session appears multiple times within one workflow, keep a single deterministic record
- if the same session appears in multiple workflows, keep the first workflow that claimed it and do not overwrite that existing session index file automatically

Operator lookup rule:

- `resolve-workflow` should prefer the canonical repo-local path first: `./.codex-deck/<workflow-id>.json`
- if the canonical file is missing, it should fall back to the mirrored registry record for the given project root plus workflow ID

## Daemon State Contract

The daemon stores shared global state under `~/.codex/codex-deck/workflows/daemon-state/` by default, with a test override available through `CODEX_DECK_DAEMON_HOME`.

Suggested contents:

- daemon id
- daemon pid
- control port
- auth token
- start time
- heartbeat time
- running/stopped state
- daemon log path
- active projects
- active workflows
- queue depth

Only one daemon should run per user daemon home.

## Skill-side behavior

The skill does not keep orchestrating after send success.

Normal control flow is:

1. create or inspect workflow
2. if the current session does not already know the workflow path and the user only gave project root plus workflow ID, resolve workflow path first
3. validate/reconcile/show if needed
4. start daemon if needed
5. send one control message (`trigger` / `daemon-send`)
6. stop immediately

Any later progress happens without the original skill turn staying active.

## Daemon-owned runtime loop

Scheduler behavior is implemented by the daemon using `scripts/workflow.py` helpers and the non-interactive continuation helper.

Trigger sources:

- user explicit trigger (`run.sh trigger --workflow ...`)
- daemon control message (`run.sh daemon-send ...`)
- automatic task completion/failure messages from `task_runner.py`

Public vs internal command naming:

- public `run.sh trigger` starts daemon if needed, enqueues a trigger request, and returns immediately
- public `run.sh daemon-send` delivers generic control messages to the daemon and returns immediately
- public `run.sh resolve-workflow --project-root <path> --workflow-id <id>` resolves the canonical workflow path, with registry fallback for session bootstrap when the workflow path is not already known
- public `run.sh prompt` maps to internal `workflow.py render-scheduler-prompt`
- internal `workflow.py trigger-scheduler` and direct finish-task helpers remain recovery/debug primitives, not the normal operator flow

Runtime semantics:

1. Ensure daemon is running.
2. Daemon receives a control message for a workflow.
3. If the message is `workflow-mutate`, persist it under `scheduler.controlMessages` and enqueue a trigger request after the mutation commits.
4. If the message is `stop-workflow-processes`, terminate active daemon-owned process groups for that workflow immediately (without waiting for the queue), run dangling-turn repair for the stopped sessions with known IDs, update workflow state/history, and return the stopped count.
5. Daemon refreshes workflow state before scheduling:
   - reconcile dead running task PIDs
   - apply stop-signal pruning
   - recompute workflow status
6. If `scheduler.running=true`, set `pendingTrigger=true` and return.
7. If `scheduler.running=true` but the run is stale, recover it and continue.
8. Otherwise set `running=true`, record trigger reason, and execute one app-server-backed scheduler turn.
9. First turn creates a persistent thread if needed.
10. Later turns send new messages into the same thread and track a `turnId`.
11. Daemon polls thread/turn state until the requested turn finishes.
12. If the thread is not loaded, daemon resumes it through app-server and retries once.
13. Scheduler edits workflow and launches workers by calling `run.sh` commands (`validate`, `ready-tasks`, `launch-task`, `reconcile`, `show`, `status`).
14. Script performs strict post-turn validation.
15. On turn failure or validation failure, workflow status becomes `failed` (except explicit stop requests).
16. Clear `running`; if `pendingTrigger=true`, clear it and rerun once.

This provides non-overlapping daemon-owned scheduler execution with coalesced re-triggering while preserving thread continuity through app-server APIs.

## App-server continuity model

Instead of raw CLI `codex resume SESSION_ID`, codex-deck uses its app-server-backed continuation helper with this thread/turn pattern:

- `thread/start` to create a scheduler thread
- `turn/start` to send each scheduler prompt
- `thread/read` to observe active/requested turn status
- `thread/resume` to recover not-loaded threads when needed

This is the intended continuity mechanism for daemon-owned scheduler execution.

The continuation helper enforces sandboxing in both layers:

- app-server process launch uses `codex --sandbox danger-full-access app-server`
- each `turn/start` request includes `sandboxPolicy={"type":"dangerFullAccess"}`

## Task Execution Flow

Each started task is executed by `scripts/task_runner.py`:

1. Read task prompt and worktree from workflow JSON.
2. Run `codex exec --sandbox danger-full-access <prompt>` in task worktree.
   - Record a `daemon_command_executed` history entry containing `source`, `cwd`, `commandType`, and `commandSummary` for UI/browser tracing.
3. Parse `session id: <uuid>` from stdout and write `sessionId` to task block.
4. Persist raw output to `./.codex-deck/logs/<task-id>.log`.
5. Collect session summary via `scripts/session_state.py`.
6. Record `resultCommit` from task worktree `HEAD`.
7. Send a daemon control message including both `projectRoot` and `workflow`:
   - `task-finished` on success
   - `task-failed` on failure
8. Daemon applies the task-finish mutation and triggers the next scheduler pass itself.

Fallback when session id is not parsed immediately:

- Prefer a narrow best-effort lookup constrained by task start time and worktree path.
- If fallback is ambiguous, leave the task session unattached rather than binding the wrong session.

## Operational references

This document is architecture/contract focused. Operational procedures are maintained in these canonical references:

- `references/commands.md` for operator command surface and intent-to-command sequences
- `references/authoring.md` for workflow/task authoring, branch strategy, and task outcome signaling
- `references/runbooks.md` for failure diagnosis and recovery
- `references/guidance-routing.md` for scheduler vs workflow-task guidance placement and `guide.md` contracts

Scheduler-specific mutation heuristics stay in:

- `references/scheduler.md` (scheduler task only)

## Command scope snapshot

The runtime command surface remains centered on:

- workflow lifecycle commands (`create`, `resolve-workflow`, `validate`, `reconcile`, `status`, `show`)
- daemon control commands (`trigger`, `daemon-start`, `daemon-status`, `daemon-send`, `stop-workflow-processes`)
- merge/session inspection commands (`merge`, `session-state`)

Internal/debug primitives still exist in scripts (`ready-tasks`, `launch-task`, `prompt`, and `workflow.py` internals), but they are not the normal fire-and-forget operator path after daemon handoff.

## Failure semantics (summary)

- task process non-zero exit reports `task-failed` to daemon
- failed tasks block dependents while unrelated dependency trees can continue
- scheduler turn or post-turn validation failure marks workflow `failed`
- stale/dead runners are reconciled into failed tasks
- `pendingTrigger` preserves new work requests that arrive during active scheduler runs
- stop-signal pruning only cancels pending tasks, never running tasks

Use `references/runbooks.md` for operational handling steps.

## Implemented Files

- `.claude/skills/codex-deck-flow/SKILL.md`
- `.claude/skills/codex-deck-flow/agents/openai.yaml`
- `.claude/skills/codex-deck-flow/scripts/run.sh`
- `.claude/skills/codex-deck-flow/scripts/workflow.py`
- `.claude/skills/codex-deck-flow/scripts/task_runner.py`
- `.claude/skills/codex-deck-flow/scripts/daemon.py`
- `.claude/skills/codex-deck-flow/scripts/daemon_client.py`
- `.claude/skills/codex-deck-flow/scripts/daemon_send.py`
- `.claude/skills/codex-deck-flow/scripts/codex_resume_noninteractive.py`
- `.claude/skills/codex-deck-flow/scripts/session_state.py`
- `.claude/skills/codex-deck-flow/scripts/session_summary.py`
