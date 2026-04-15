---
name: codex-deck-terminal
description: Plan shell commands from natural language using a strict machine-readable XML-like contract, one non-interactive command per step, explicit user approval or refusal, failure recovery, and requirement_finished completion signaling. Use when the user wants AI-terminal behavior, stepwise shell planning, or command proposals that another process or UI will parse and execute.
---

# Plan Shell Workflows For Approval-First Execution

Use this skill when the goal is to propose shell commands, not to run them immediately.

## Core behavior

- Propose exactly one shell command per reply.
- Keep every proposed command non-interactive.
- Wait for explicit user approval before any command is executed by the caller.
- If the caller or user rejects a command, propose an alternative next command instead of insisting on the same one.
- If the caller reports an execution failure, explain the likely cause briefly and propose one recovery command.
- When the task is complete, emit `<requirement_finished>...</requirement_finished>` and no `<command>` tag.

## Environment grounding

- Use the current machine environment, not a hardcoded OS assumption.
- If the caller already supplied the current system release, architecture, shell, and cwd, trust that context.
- If that context is missing and you have local tool access, inspect the machine before proposing commands.
- Prefer concrete release strings such as `macOS 15.4.1` or `Ubuntu 24.04.2 LTS` over generic labels like `Linux`.

## Response contract

Respond with XML-like tags only.

Required tags for command proposals:

```xml
<state>await_approval|need_input|step_ready|step_failed|finished</state>
<command><![CDATA[exactly one shell command]]></command>
<explanation>Brief explanation of key flags or terms.</explanation>
<cwd>execution directory</cwd>
<shell>shell name</shell>
<risk>low|medium|high</risk>
<step_id>stable short id</step_id>
<step_goal>short goal</step_goal>
<next_action>approve|edit|reject|provide_input</next_action>
```

Optional tags:

```xml
<failure_reason>permission|missing_dependency|invalid_path|runtime_error|timeout|unknown</failure_reason>
<troubleshooting>Brief cause and suggested fix.</troubleshooting>
<needs_input>Question for the user when information is missing.</needs_input>
<context_note>Short note summarizing relevant prior progress.</context_note>
```

Completion tag:

```xml
<requirement_finished>Further suggestions or precautions.</requirement_finished>
```

## Output discipline

- Do not emit prose outside the XML-like tags.
- Do not emit multiple `<command>` tags.
- Do not emit `<command>` when `state` is `need_input` or `finished`.
- Default `cwd` to the caller-provided current directory when the user did not specify one.
- Keep explanations short because other processes may parse this output.

## Long-output rule

- Do not rely on long raw command output being fed back into context.
- When the caller provides summarized output plus an output reference, reason from the summary first.
- Use concise execution summaries to choose the next step.
