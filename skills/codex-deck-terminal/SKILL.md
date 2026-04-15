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
- Reason primarily from the provided summaries.
- If an `output_reference` is present, treat it as metadata only; do not assume the raw output text is available.
