# Command Reference (Operator Canonical)

This file is the canonical operational command reference for codex-deck-flow skill usage.

Run commands from the repository root unless noted.

## Runtime principles

- The skill is an operator control client, not the long-running orchestrator.
- The daemon owns ongoing workflow execution after `trigger` or `daemon-send` succeeds.
- Keep merge explicit. Never apply merge unless the user explicitly requests it.

## Preflight checklist

Before choosing a command sequence, confirm:

1. Which workflow file is being operated on.
2. Whether the workflow validates.
3. Whether runtime state should be reconciled.
4. Whether execution should start now or wait for approval.

## Command usage output

`run.sh` supports:

```bash
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" create --title <title> --request <request> [--task-count N>=0] [--target-branch <branch>] [--json]
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" trigger --workflow <path>
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" daemon-start
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" daemon-stop
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" daemon-status
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" stop-workflow-processes --workflow <path>
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" daemon-send --workflow <path> --type <message-type> [--payload-json <json>]
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" resolve-workflow --project-root <path> --workflow-id <id> [--codex-home <path>] [--json]
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" validate --workflow <path> [--json]
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" ready-tasks --workflow <path> [--json]
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" launch-task --workflow <path> --task-id <id>
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" reconcile --workflow <path>
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" status --workflow <path>
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" show --workflow <path>
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" prompt --workflow <path> [--reason <reason>]
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" merge --workflow <path> [--preview] [--apply]
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" session-state --session-id <id> [--codex-home <path>]
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" backfill-registry [--project-root <path>] [--codex-home <path>]
```

## Intent to command sequences

### 1) Create a new workflow

Use when user asks to create a new multi-task workflow.

```bash
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" create --title "<title>" --request "<request>" [--tasks-json <file> | --task-count N] [--target-branch <branch>] [--max-parallel <n>] [--codex-home <path>] [--json]
```

Then immediately:

```bash
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" validate --workflow <workflow-path>
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" show --workflow <workflow-path>
```

Then summarize tasks/dependencies/prompts and wait for approval before `trigger`.

Notes:

- If `--target-branch` is omitted, create uses current checked-out branch in project root.
- It falls back to `main` only when Git cannot resolve a named branch.
- `--task-count 0` is valid and creates an empty draft (`tasks: []`).
- Negative task counts are rejected.
- If requested workflow ID already exists in same project root after sanitization, create fails and suggests alternatives.

### 2) Resume or inspect existing workflow by known path

```bash
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" validate --workflow <workflow-path>
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" reconcile --workflow <workflow-path>
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" status --workflow <workflow-path>
```

Optional daemon health:

```bash
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" daemon-status
```

### 2a) Bootstrap existing workflow by project root + workflow ID

Use only when current session does not already know workflow path.

```bash
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" resolve-workflow --project-root <project-root> --workflow-id <workflow-id>
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" validate --workflow <workflow-path>
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" reconcile --workflow <workflow-path>
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" status --workflow <workflow-path>
```

### 3) Start or continue execution

After user approval:

```bash
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" trigger --workflow <workflow-path>
```

`trigger` ensures daemon is running, enqueues trigger, and returns immediately.
Stop the skill turn after success.

### 4) Send explicit daemon control message

Use when user wants re-trigger or explicit mutation.

```bash
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" daemon-send --workflow <workflow-path> --type <message-type> [--payload-json <json-or-file>]
```

Important message types:

- `enqueue-trigger`: request scheduler pass now, or pending rerun if already active.
- `workflow-mutate`: store control message and request trigger for immediate/next pass.
- `stop-workflow-processes`: stop daemon-started workflow processes and apply dangling-turn repair for known session IDs.

Alias:

```bash
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" stop-workflow-processes --workflow [absolute path to the workflow JSON file]
```

When user only provides project root + workflow ID, resolve first unless current session already knows the path.
After send succeeds, stop.

### 5) Inspect daemon later

```bash
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" daemon-status
```

### 6) Inspect task session later

```bash
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" session-state --session-id <session-id> [--codex-home <path>]
```

### 7) Merge only when explicitly requested

Preview:

```bash
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" merge --workflow <workflow-path>
```

Apply only with explicit user request:

```bash
"${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/run.sh" merge --workflow <workflow-path> --apply
```

## Optional later inspection

`status`, `show`, `session-state`, and `daemon-status` are for explicit later checks and are not part of the initial trigger handoff after enqueue succeeds.
