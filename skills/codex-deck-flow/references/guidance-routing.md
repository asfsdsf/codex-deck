# Guidance Routing (Scheduler vs Workflow Tasks)

This file is the canonical routing guide for project-specific remembered rules.

## Routing rules

- Put scheduler/orchestration rules in `./.codex-deck/scheduler/`.
- Put workflow-task execution rules (tests, implementation checks, task-level validation) in `./.codex-deck/flow_tasks/`.
- If one instruction contains both scheduler and workflow-task rules, split it into separate guidance files and index each in the matching `guide.md`.

Routing example:

- `Please let tasks run unit test to pass all unit tests after the task. If any tests fail, fix code until all tests pass.` belongs in `./.codex-deck/flow_tasks/`, not `./.codex-deck/scheduler/`.

## Scheduler guidance files contract

Scheduler-only loading rule:

- Scheduler task must read `./.codex-deck/scheduler/guide.md` before scheduling decisions.
- Only scheduler task may read files under `./.codex-deck/scheduler/`.
- Do not load `./.codex-deck/scheduler/` files for `llm`, `daemon`, or workflow worker tasks.

`guide.md` contract:

- `guide.md` is index for all scheduler guidance markdown files under `./.codex-deck/scheduler/`.
- Each guidance markdown file must have one index entry in `guide.md`.
- Keep entries compact to reduce context usage.
- Use one-line bullet entries only in this format:
  - `- <file-name>.md: <very short rule summary>`
- Do not use numbered headings or multi-line `Path`/`Purpose`/`Scratch notes` blocks in `guide.md`.
- Keep each summary concise (prefer about 8-20 words); full details belong in referenced markdown files.

Authoring and maintenance:

- User may manually edit `guide.md` and indexed guidance markdown files.
- User may ask codex-deck to create or edit `guide.md` and indexed guidance files.
- If user asks codex-deck to remember a new scheduler rule and `guide.md` does not exist, create `./.codex-deck/scheduler/guide.md`.
- When creating a new guidance markdown file, add or update index entry in `guide.md` in the same change.
- Keep `guide.md` aligned with real file set under `./.codex-deck/scheduler/` (no unindexed guidance markdown files).
- Place only scheduler/orchestration rules in `./.codex-deck/scheduler/`.

Example remember-rule flow:

- User instruction example:
  - `Please remember that when you first see a workflow, record it in [absolute path to project root]/workflow_record.md.`
- codex-deck should:
  - create guidance file under `./.codex-deck/scheduler/`, such as `record-first-seen-workflow.md`
  - store scheduler rule in that file
  - add compact one-line `guide.md` index entry for that file

## Workflow-task guidance files contract

Workflow-task-only loading rule:

- Workflow tasks must read `./.codex-deck/flow_tasks/guide.md` before implementation work.
- Only workflow tasks may read files under `./.codex-deck/flow_tasks/`.
- Do not load `./.codex-deck/flow_tasks/` files for `llm` (flow chat session/main agent), `daemon`, or scheduler tasks.

`guide.md` contract:

- `guide.md` is index for all workflow-task guidance markdown files under `./.codex-deck/flow_tasks/`.
- Each guidance markdown file must have one index entry in `guide.md`.
- Keep entries compact to reduce context usage.
- Use one-line bullet entries only in this format:
  - `- <file-name>.md: <very short rule summary>`
- Do not use numbered headings or multi-line `Path`/`Purpose`/`Scratch notes` blocks in `guide.md`.
- Keep each summary concise (prefer about 8-20 words); full details belong in referenced markdown files.

Authoring and maintenance:

- User may manually edit `guide.md` and indexed guidance markdown files.
- User may ask codex-deck to create or edit `guide.md` and indexed guidance files.
- If user asks codex-deck to remember a new workflow-task rule and `guide.md` does not exist, create `./.codex-deck/flow_tasks/guide.md`.
- When creating a new guidance markdown file, add or update index entry in `guide.md` in the same change.
- Keep `guide.md` aligned with real file set under `./.codex-deck/flow_tasks/` (no unindexed guidance markdown files).

Example remember-rule flow:

- User instruction example:
  - `Please let tasks run unit test to pass all unit tests after the task. If any tests fail, fix code until all tests pass.`
- codex-deck should:
  - create guidance file under `./.codex-deck/flow_tasks/`, such as `run-unit-tests-until-pass.md`
  - store workflow-task rule in that file
  - add compact one-line `guide.md` index entry for that file
