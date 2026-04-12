# Workflow and Task Authoring (Operator Canonical)

Use this guide when creating workflows, editing tasks, or writing task prompts.

## Workflow authoring rules

- Write specific task prompts whenever intended behavior is known.
- Prefer narrow per-task execution briefs over repeating the full workflow request.
- Use `dependsOn` only for real blockers.
- Leave `--target-branch` unset when workflow should merge back to current checked-out branch.
- Pass `--target-branch` only when a different merge target is intentionally required.
- If branch resolution is unavailable, codex-deck falls back to `main`.

## Branching and parallelism

- Use separate branches for independent work that may run in parallel.
- Reuse the same branch only for tightly coupled sequential chains.
- Shared-branch tasks must be dependency-ordered.
- `validate` rejects unordered shared-branch layouts.
- `launch-task` handles shared-branch handoff by removing finished predecessor worktree before attaching next task worktree.

## Task outcome signaling contract

- If a task may make remaining pending tasks unnecessary, instruct it to include `[codex-deck:stop-pending]` in final summary.
- Runtime records structured `stopPending=true` when detected.
- If a task may legitimately require no code changes, instruct it to clearly state `no-op` in final summary.
- Runtime records structured `noOp=true` when detected.

## Commit/no-op contract

- Successful non-no-op tasks must end with a new commit.
- No-op tasks may succeed without a new commit.

## Fresh-session prompt guidance

When operating an existing workflow from a new chat session:

- Include exact project root and workflow ID when workflow path is not already known in current session.
- Prefer prompts that explicitly ask to resolve then inspect state before mutation.
- For add-task mutations, make the new task prompt concrete about changed surface, visible outcome, and verification.

Example:

```text
For skill codex-deck-flow, use project root /absolute/project/path and workflow ID the-workflow-id.
Resolve the workflow, inspect its current state, and then add one task that fixes the UI style on the relevant web page.
Use the existing codex-deck-flow mutation path instead of inventing a new command.
The new task prompt should be specific about the page, the styling goal, and how to verify the result.
```
