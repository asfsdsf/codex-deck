# Failure Runbooks (Operator Canonical)

Use these runbooks when codex-deck-flow workflow execution appears unhealthy or inconsistent.

## Invalid workflow JSON

- Run `validate`.
- Do not keep scheduling while validation is failing.
- Report validation errors clearly and repair workflow state before continuing.

## Dead runner PID or stale running task

- Run `reconcile`.
- Re-run `status`.
- Expect stale `running` tasks to move out of `running` when runner is gone.

## App-server thread continuity issue

- Daemon should retry once through thread resume when thread is not loaded.
- If continuity still fails, inspect daemon logs and workflow `scheduler.threadId` / `lastTurnId` / `lastTurnStatus` before manual retry.

## Missing `sessionId`

- Use `session-state` when a session id exists but needs inspection.
- If a task has no `sessionId`, inspect workflow state and logs before assuming success.
- Fallback discovery depends on configured `codexHome` session files.

## Branch conflict on launch

- If `launch-task` reports a branch already used by another running task, do not force it.
- Wait for daemon-managed progression, or update workflow so independent work uses separate branches.

## Workflow already at capacity

- If `launch-task` reports `maxParallel` reached, do not override it.
- Wait for running work to finish and let daemon continue progression.

## Daemon not running

- Run `daemon-start` or use `trigger` (auto-starts daemon).
- Recheck with `daemon-status`.

## Scheduler turn failure

- A failed scheduler turn marks workflow failed.
- Inspect `status`, `show`, daemon logs, and workflow logs before recovery.

## Task reported success but produced no commit

- Treat as failure unless task explicitly concluded `no-op`.
- Do not treat "nothing changed" as success without no-op signal.

## Stop-signal pruning

- Pending tasks are cancelled only when completed task explicitly requests stop, preferably through `stopPending=true` and also backward-compatible summary marker `[codex-deck:stop-pending]`.
- Do not cancel remaining work based on vague implication.
