---
name: codex-deck-terminal
description: Plan approval-first terminal workflows for codex-deck using markdown plus machine-readable HTML-like tags. Use when a controller or UI should parse shell-step proposals, show executable cards, react to approval or rejection, and continue from structured execution summaries.
---

# Plan Shell Workflows For Controller-Reactive Execution

Use this skill when the goal is to propose shell steps for a terminal controller, not to run them directly.

## Core behavior

- Write normal markdown plus exactly one actionable terminal tag block in each reply when the controller should react.
- A reply may contain multiple commands only as ordered steps inside one `<ai-terminal-plan>`.
- Each `<ai-terminal-step>` must contain exactly one non-interactive shell command.
- Wait for explicit user approval before any command is executed by the controller.
- If the user or controller rejects a step, revise the plan instead of insisting on the same command.
- If the controller reports a step failure, briefly explain the likely cause and return a revised next plan.
- When the task is complete, emit `<requirement_finished>...</requirement_finished>` and no plan block.

## Environment grounding

- Use the current machine environment supplied by the controller. Do not assume Ubuntu 22.04 or any fixed OS.
- Trust the controller-provided terminal id, cwd, shell, OS release, architecture, and platform.
- Prefer concrete release strings such as `macOS 15.4.1` or `Ubuntu 24.04.2 LTS`.
- Default to the controller-provided cwd when the user did not specify another working directory.

## Output contract

The controller parses exactly one of these top-level blocks from each reply:

### Action plan

```xml
<ai-terminal-plan>
  <context_note>optional shared note</context_note>
  <ai-terminal-step>
    <step_id>stable short id</step_id>
    <step_goal>short goal</step_goal>
    <command><![CDATA[exactly one shell command]]></command>
    <cwd>execution directory</cwd>
    <shell>shell name</shell>
    <risk>low|medium|high</risk>
    <next_action>approve|reject|provide_input</next_action>
    <explanation>brief explanation of key flags or terms</explanation>
    <context_note>optional step note</context_note>
  </ai-terminal-step>
</ai-terminal-plan>
```

Rules:

- Keep `<ai-terminal-step>` blocks in execution order.
- Use short stable `step_id` values because the controller reports execution feedback by `step_id`.
- Use `provide_input` only when the user must answer before a safe command can be proposed.

### Need input

```xml
<ai-terminal-need-input>
  <question>short question for the user</question>
  <context_note>optional note</context_note>
</ai-terminal-need-input>
```

### Completion

```xml
<requirement_finished>Further suggestions or precautions.</requirement_finished>
```

## Controller feedback you will receive

The controller may send structured follow-up blocks in user messages.

### Frozen terminal context in user messages

User messages may include a frozen `<terminal-command-output>` block that captures terminal context for the request.

Notes:

- The frozen transcript may be partial.
- When character truncation happens, the transcript may include a `<codex-deck-frozen-terminal-omitted-characters-notice>` tag describing how many trailing characters were skipped.
- When middle-line truncation happens, the transcript may include a `<codex-deck-frozen-terminal-omitted-lines-notice>` tag describing how many middle lines were skipped.
- Treat those omission tags as controller metadata, not shell output.

- User messages may include `<terminal-restart-message>...</terminal-restart-message>`.
- This means the terminal was restarted and shell state may be lost, for example environment variables or aliases.

### Step execution result

```xml
<ai-terminal-execution>
  <step_id>step id</step_id>
  <status>success|failed|timed_out</status>
  <exit_code>numeric exit code if known</exit_code>
  <cwd_after>cwd after running the step</cwd_after>
  <output_summary><![CDATA[concise output summary]]></output_summary>
  <error_summary><![CDATA[concise error summary]]></error_summary>
  <output_reference>optional controller-specific output reference</output_reference>
</ai-terminal-execution>
```

### Step rejection

```xml
<ai-terminal-feedback>
  <step_id>step id</step_id>
  <decision>rejected</decision>
  <reason>optional rejection reason</reason>
</ai-terminal-feedback>
```

Use these feedback blocks to revise the next plan, continue from success, or recover from failure.

## Output discipline

- Do not emit more than one top-level actionable block in a single reply.
- Do not emit raw XML-only responses without markdown context unless brevity makes that best.
- Keep markdown concise because the controller may embed the tagged content as UI cards.
- Do not put multiple shell commands into one `<command>`.

## Long-output rule

- Do not rely on full raw terminal output being fed back into context.
- Reason primarily from the provided summaries and any visible frozen transcript text.
- If an `output_reference` is present, treat it as metadata only; do not assume the raw output text is available.
- Frozen `<terminal-command-output>` content may also be partial even when inline text is present.
- Omitted frozen-output sections may be marked with long custom notice tags for omitted characters or omitted middle lines; treat those notices as authoritative controller metadata and do not infer hidden content.
- If omitted frozen content would materially affect the next step, inspect the saved terminal artifacts with the helper scripts yourself instead of guessing.

## Local inspection scripts

Use the scripts in `scripts/` as skill helper scripts when you need to inspect stored terminal artifacts directly. These scripts are read-only.

- Run these scripts yourself from the repo workspace as part of the skill workflow.
- Do not emit these script invocations inside `<ai-terminal-plan>`.
- Do not ask the terminal controller to run these scripts unless the user explicitly wants that.

- `python3 scripts/terminal_session_summary.py <terminal-id> [--codex-home <path>] [--recent <N>]`
  - Prints a compact JSON summary of the terminal-session flow rather than the raw manifest.
  - Always shows `terminalId`, `sessionId`, and a `blocks` array.
  - Shows each block's 1-based `index`, `blockId`, and `type`.
  - For `terminal_snapshot` blocks, includes `captureKind`, optional `stepId`, and a 1000-character `snapshotPreview`.
  - For AI terminal message blocks, includes only flow-relevant fields such as steps, step actions, step feedback, question, completion message, and surrounding markdown when present.
  - `--recent <N>` limits the `blocks` array to the most recent N saved blocks.
- `python3 scripts/terminal_session_blocks.py <terminal-id> <block> [<block> ...] [--codex-home <path>] [--line-range <start>:<end>]`
  - Prints content for one or more blocks in a terminal session.
  - A block selector can be a `blockId` or a 1-based block index from the manifest.
  - For `terminal_snapshot` blocks, saved block content comes from the serialized snapshot file referenced by `snapshotPath`.
  - For AI terminal message blocks, saved block content comes from the inline manifest fields, usually `rawBlock`.
  - When omission tags in a frozen `<terminal-command-output>` block are not enough, use this helper script to inspect the underlying saved text, but only when the omitted content is needed for the next step.
  - Add a per-block one-based inclusive line range with `@`, for example `block-mabc123@20:80`, `block-mabc123@20:`, or `3@1:40`.
  - `--line-range` applies to selectors that do not include their own `@` range.
