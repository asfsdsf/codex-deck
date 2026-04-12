---
name: codex-deck-flow
description: Use this skill when the user asks for persistent multi-agent coding workflows with task dependencies, per-task codex sessions, git worktree isolation, and explicit merge flow backed by one JSON workflow file under ./.codex-deck/. Always use this skill when the user explicitly mentions `$codex-deck-flow` or `codex-deck-flow`.
allowed-tools: Bash(${CLAUDE_PROJECT_DIR}/.claude/skills/codex-deck-flow/scripts/*:*)
---

# Orchestrate Persistent Multi-Agent Workflows

Use this skill to create workflows, inspect workflows, and send control messages to the background codex-deck-flow daemon.

This skill is an **operator control client**, not the long-running orchestrator. After the daemon has started successfully and a control message has been sent successfully, the skill should stop.

Detailed operational guidance is routed through `references/*.md`:

- Command sequences and syntax: `references/commands.md`
- Workflow/task authoring rules: `references/authoring.md`
- Failure recovery runbooks: `references/runbooks.md`
- Scheduler vs workflow-task guidance placement: `references/guidance-routing.md`
- Architecture, contracts, and role prompts: `references/agent-flow-design.md`
- Scheduler mutation heuristics (scheduler task only): `references/scheduler.md`

## Mandatory activation contract

- If the user explicitly mentions `$codex-deck-flow` or `codex-deck-flow`, treat that as a strict instruction to use this workflow system.
- Do not switch to direct ad-hoc coding as the primary path while that request is active.
- In the first response after activation, say that codex-deck-flow orchestration is active and state the first command you are running.
- If the user gives `project root` plus `workflow ID` for a workflow that the current session has not created, loaded, or already resolved, first run `resolve-workflow`, then continue with `validate`, `reconcile`, and `status`.
- If the current session already knows the workflow path from `create`, a previous `resolve-workflow`, or earlier inspection in the same chat, reuse that path instead of resolving again.
- If the user already gave a workflow path, start with `validate`, then `reconcile`, then `status`.
- If no workflow exists yet, start with `create`, then immediately `validate`, then `show` or `status`, and present the authored tasks/prompts for user approval before `trigger`.
- If the user explicitly includes `Strict task creating mode`, keep the normal create/validate/show flow, but use the strict authoring protocol described below.
- Keep merge explicit. Never run `merge --apply` unless the user explicitly asked to apply the integration branch into the target branch.
- Once `trigger` or `daemon-send` succeeds, stop. Do not continue the same skill turn as if it were the orchestrator.

## Strict task creating mode

When the user explicitly includes `Strict task creating mode`, treat that as a workflow-authoring protocol layered on top of the normal codex-deck-flow create flow.

Rules:

- Still run `create`, then `validate`, then `show` or `status` as usual.
- The draft workflow JSON already exists after `create`; approval still gates `trigger`, not draft creation.
- If you must ask the user a clarifying question before the workflow is ready, the assistant message must end with exactly:
  - `<codex-deck-flow>Question<codex-deck-flow/>`
- When asking the user to approve the authored workflow, the assistant message must end with exactly:
  - `<codex-deck-flow>Request approve:workflow-file-name.json<codex-deck-flow/>`
- Replace `workflow-file-name.json` with the JSON file name only, for example `feature-delivery.json`.
- Use only the file name token after `Request approve:`. Do not add brackets or extra wrappers.
- Do not put any additional text after the strict tag suffix.
- Once the user approves, exit strict task creating mode and continue with the normal codex-deck-flow flow.
- If the approval message includes workflow data for an already-created draft, reuse that workflow and do **not** run `create` again.
- The approval workflow data may include fields such as `workflowPath`, `workflowFileName`, `workflowId`, `projectRoot`, and `boundSessionId`; treat that as the canonical handoff for reusing the already-authored draft.

## Core runtime model

- One workflow = one JSON file under `./.codex-deck/`.
- The daemon is the orchestration owner and can serve workflows from multiple project roots.
- The skill starts daemon if needed, sends one control message, then stops.
- Worker tasks run in isolated `git worktree` directories.
- Scheduler continuity should use codex-deck-flow non-interactive app-server-backed resume behavior (`scripts/codex_resume_noninteractive.py` behavior model), not raw `codex resume SESSION_ID` semantics in daemon mode.

Use `references/agent-flow-design.md` for full runtime contracts and role data.

## Route by intent

Use this decision route, then follow details in `references/commands.md`:

1. New workflow request: `create` -> `validate` -> `show/status` -> user approval -> `trigger`
2. Existing workflow by known path: `validate` -> `reconcile` -> `status`
3. Existing workflow by project root + workflow ID when path unknown in current session: `resolve-workflow` -> `validate` -> `reconcile` -> `status`
4. Explicit daemon control message: `daemon-send` or `stop-workflow-processes`
5. Merge request: `merge` preview, and `merge --apply` only if explicitly requested

## Reference loading boundaries

- Scheduler task only: `references/scheduler.md`
- Scheduler/workflow-task guidance file rules and routing: `references/guidance-routing.md`
- Non-scheduler roles should not load scheduler-specific mutation guidance.

## References

Canonical references:

- `references/commands.md`
- `references/authoring.md`
- `references/runbooks.md`
- `references/guidance-routing.md`
- `references/agent-flow-design.md`
- `references/scheduler.md` (scheduler task only)

Implementation scripts:

- `scripts/workflow.py`
- `scripts/task_runner.py`
- `scripts/daemon.py`
- `scripts/daemon_client.py`
- `scripts/codex_resume_noninteractive.py`
- `scripts/session_state.py`
- `scripts/session_summary.py`
