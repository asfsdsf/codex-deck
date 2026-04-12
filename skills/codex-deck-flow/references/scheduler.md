# Scheduler Guide (Scheduler Task Only)

This reference is scheduler-only. Do not use it for `llm`, `daemon`, or workflow worker tasks.

## Project guidance files

Read project scheduler guidance before orchestration decisions:

- Required index file: `./.codex-deck/scheduler/guide.md`
- Required behavior: read `guide.md`, then read every markdown file indexed by `guide.md`.
- Scope rule: only scheduler tasks read `./.codex-deck/scheduler/` guidance files.
- Separation rule: do not read workflow-task guidance files under `./.codex-deck/flow_tasks/`.

`guide.md` is the index and should map guidance files to short scratch notes about how each file should be applied.
Keep `guide.md` compact: use one-line bullets like `- <file>.md: <short summary>` and keep details in the referenced file.

## Purpose

Use this guide when deciding whether to update task content or delete tasks that have not started yet.

Typical reasons:

- A finished task already implemented the pending task's functionality.
- A pending task prompt conflicts with behavior introduced by earlier completed tasks.
- Scope changed and a pending task should be narrowed, merged, or removed.

## Required Status Check

Before changing or deleting a task, the scheduler must verify the task is truly not started.

Treat a task as not started only when all of these are true:

- `status == "pending"`
- `startedAt` is empty
- `sessionId` is empty
- `runnerPid` is empty
- `worktreePath` is empty
- `resultCommit` is empty
- `finishedAt` is empty

If any check fails, do not edit or delete that task in place.

## Safe Mutation Rules

Allowed only for not-started tasks:

- Update `prompt` to remove conflicts, clarify scope, or reflect completed prerequisites.
- Update `name` when prompt meaning changes enough to require a clearer title.
- Update `dependsOn` to reflect the real dependency graph after earlier task outcomes.
- Delete the task if it is fully redundant.

Never do these:

- Do not mutate or delete tasks with `status` in `running`, `success`, `failed`, or `cancelled`.
- Do not mutate or delete a task that has any non-empty started marker fields.
- Do not leave references to deleted task IDs in other tasks' `dependsOn`.

## Delete Flow for Redundant Pending Tasks

When deleting a pending task because work is already implemented:

1. Confirm the candidate task is not started using the required checks.
2. Find all tasks that depend on the candidate task ID.
3. Rewire each dependent task's `dependsOn` list to remove the deleted ID, and add replacement dependencies only when truly required.
4. Ensure no task references a missing dependency ID.
5. Run workflow validation and confirm it succeeds.

## Change Flow for Conflicting Pending Tasks

When a pending task conflicts with already completed work:

1. Keep the task ID if the task is still needed.
2. Rewrite the prompt so it builds on existing outcomes instead of redoing them.
3. Update dependencies so the task starts after the specific prerequisite tasks that now matter.
4. Keep acceptance language explicit so the worker can validate expected behavior.
5. Run workflow validation and confirm it succeeds.

## Scheduler Decision Heuristic

Prefer prompt edits over deletion when there is uncertainty about remaining value.
Delete only when the pending task is clearly redundant.

Before launching any new work after mutation:

1. Re-run status checks.
2. Confirm ready tasks still make sense with updated dependencies.
3. Launch only dependency-valid pending tasks.
