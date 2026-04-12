#!/usr/bin/env python3
"""Execute one codex-deck worker task inside its assigned worktree.

This script is spawned by ``workflow.py`` after a task is marked running. It is
responsible for running ``codex exec``, attaching the discovered session id back
to workflow state, deriving workflow-specific outcome flags from the session,
and reporting the final result to the daemon.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import re
import subprocess
import sys
import time

from daemon_client import post_json
from workflow import (
    append_history,
    codex_command,
    codex_env,
    load_json,
    summarize_daemon_command_for_history,
    with_lock,
    write_json,
)

SESSION_ID_REGEX = re.compile(r"session id:\s*([0-9a-fA-F\-]{36})", re.IGNORECASE)
SESSION_ID_EXACT_REGEX = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
SESSION_ID_SUFFIX_REGEX = re.compile(r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$")


def run_cmd(cmd: list[str], cwd: str | None = None) -> tuple[int, str]:
    proc = subprocess.run(cmd, cwd=cwd, text=True, capture_output=True)
    output = (proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")
    return proc.returncode, output


def run_workflow_cmd(script: pathlib.Path, args: list[str]) -> tuple[int, str]:
    return run_cmd([sys.executable, str(script), *args])


def parse_iso(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def load_task(workflow: pathlib.Path, task_id: str) -> tuple[dict[str, object], dict[str, object] | None]:
    """Load the workflow JSON and return the current snapshot of one task."""

    data = json.loads(workflow.read_text(encoding="utf-8"))
    task = None
    for item in data.get("tasks", []):
        if isinstance(item, dict) and item.get("id") == task_id:
            task = item
            break
    return data, task


def notify_daemon(workflow: pathlib.Path, message_type: str, payload: dict[str, object]) -> None:
    """Send a task result event back to the daemon control queue."""

    workflow_data, _task = load_task(workflow, str(payload.get("taskId") or ""))
    workflow_block = workflow_data.get("workflow") if isinstance(workflow_data, dict) else None
    project_root_text = (
        str(workflow_block.get("projectRoot") or "").strip()
        if isinstance(workflow_block, dict)
        else ""
    )
    project_root = pathlib.Path(project_root_text).expanduser().resolve() if project_root_text else workflow.parent.parent.resolve()
    post_json(
        project_root,
        "/enqueue",
        {
            "type": message_type,
            "projectRoot": str(project_root),
            "workflow": str(workflow.resolve()),
            "reason": "task-finished",
            "payload": payload,
        },
    )



def fail_and_trigger(workflow: pathlib.Path, wf_script: pathlib.Path, task_id: str, reason: str) -> int:
    """Report task failure, falling back to direct workflow mutation if needed."""

    try:
        notify_daemon(
            workflow,
            "task-failed",
            {
                "taskId": task_id,
                "failureReason": reason,
                "summary": "",
                "resultCommit": "",
            },
        )
    except Exception:
        run_workflow_cmd(
            wf_script,
            [
                "finish-task",
                "--workflow",
                str(workflow),
                "--task-id",
                task_id,
                "--failure-reason",
                reason,
            ],
        )
    print(reason, file=sys.stderr)
    return 1


def maybe_set_task_session(workflow: pathlib.Path, wf_script: pathlib.Path, task_id: str, session_id: str) -> None:
    """Persist a discovered session id back into workflow state when valid."""

    if not SESSION_ID_EXACT_REGEX.fullmatch(session_id):
        return
    run_workflow_cmd(
        wf_script,
        [
            "set-task-session",
            "--workflow",
            str(workflow),
            "--task-id",
            task_id,
            "--session-id",
            session_id,
        ],
    )


def record_daemon_command(
    workflow: pathlib.Path,
    *,
    source: str,
    task_id: str,
    cwd: str,
    command: list[str],
) -> None:
    """Append one daemon-owned command event into workflow history."""

    lock_path = workflow.with_suffix(".lock")
    try:
        with with_lock(lock_path):
            data = load_json(workflow)
            scheduler = data.get("scheduler")
            if not isinstance(scheduler, dict):
                return
            if str(scheduler.get("controllerMode") or "direct") != "daemon":
                return
            command_info = summarize_daemon_command_for_history(command)
            if command_info is None:
                return
            append_history(
                data,
                "daemon_command_executed",
                {
                    "source": source,
                    "taskId": task_id,
                    "cwd": cwd,
                    "commandType": command_info["commandType"],
                    "commandSummary": command_info["commandSummary"],
                },
            )
            write_json(workflow, data)
    except Exception:
        # Command tracing is best-effort and should not block task execution.
        return


def extract_session_id_from_file(path: pathlib.Path) -> str:
    match = SESSION_ID_SUFFIX_REGEX.search(path.stem)
    if match:
        return match.group(1)
    try:
        first = path.read_text(encoding="utf-8", errors="replace").splitlines()[0]
        parsed = json.loads(first)
    except Exception:
        return ""
    payload = parsed.get("payload", {}) if isinstance(parsed, dict) else {}
    if isinstance(payload, dict):
        value = str(payload.get("id") or "").strip()
        if SESSION_ID_EXACT_REGEX.fullmatch(value):
            return value
    return ""


def fallback_latest_session_id(codex_home: str, started_at: str | None, worktree: str | None = None) -> str:
    """Best-effort session lookup when stdout did not expose the session id.

    The fallback stays intentionally conservative: it narrows candidates by time
    window and optional worktree path and refuses to guess when more than one
    plausible session exists.
    """

    home = pathlib.Path(codex_home).expanduser().resolve()
    sessions_dir = home / "sessions"
    if not sessions_dir.is_dir():
        return ""
    started_dt = parse_iso(started_at)
    min_epoch: float | None = None
    max_epoch: float | None = None
    if started_dt is not None:
        min_epoch = started_dt.timestamp() - 10.0
        max_epoch = started_dt.timestamp() + 300.0
    normalized_worktree = os.path.realpath(worktree) if worktree else ""
    candidates: list[str] = []
    files = sorted(sessions_dir.rglob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    for path in files[:100]:
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        if min_epoch is not None and mtime < min_epoch:
            continue
        if max_epoch is not None and mtime > max_epoch:
            continue
        if normalized_worktree:
            try:
                first = path.read_text(encoding="utf-8", errors="replace").splitlines()[0]
                if normalized_worktree not in first:
                    continue
            except Exception:
                continue
        session_id = extract_session_id_from_file(path)
        if session_id:
            candidates.append(session_id)
            if len(candidates) > 1:
                return ""
    return candidates[0] if len(candidates) == 1 else ""



def sanitize_id(value: str) -> str:
    out = "".join(ch.lower() if ch.isalnum() else "-" for ch in value.strip())
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-") or "task"



def run_git_text(worktree: str, args: list[str]) -> str:
    rc, out = run_cmd(["git", "-C", worktree, *args])
    return out.strip() if rc == 0 else ""



def compact_text(value: str, max_len: int = 400) -> str:
    text = " ".join(value.split())
    if len(text) <= max_len:
        return text
    return text[: max_len - 3].rstrip() + "..."



def detect_task_kind(summary: str, prompt: str, success: bool, no_op: bool) -> str:
    """Classify the task outcome so the explainer can suggest verification."""

    text = f"{summary}\n{prompt}".lower()
    if not success:
        return "failure"
    if no_op:
        return "no-op"
    if any(term in text for term in ("bug", "fix", "regression", "reproduce", "broken", "issue")):
        return "bug-fix"
    if any(term in text for term in ("feature", "add ", "new ", "support ", "enable", "implement")):
        return "feature"
    if any(term in text for term in ("refactor", "cleanup", "internal", "rename", "restructure")):
        return "internal-change"
    return "change"



def explainer_filename(workflow_id: str, task_id: str) -> str:
    return f".codex-deck-{sanitize_id(workflow_id)}-{sanitize_id(task_id)}.md"



def build_task_explainer(
    *,
    workflow_id: str,
    workflow_request: str,
    task_id: str,
    task_name: str,
    task_prompt: str,
    branch_name: str,
    status: str,
    summary: str,
    failure_reason: str,
    no_op: bool,
    stop_pending: bool,
    base_commit: str,
    result_commit: str,
    commit_subject: str,
    changed_files: list[str],
) -> str:
    """Render a human-readable markdown explainer into the task worktree."""

    task_kind = detect_task_kind(summary, task_prompt, status == "success", no_op)
    lines = [
        f"# Codex Deck Task Explainer: {task_name or task_id}",
        "",
        "## Task overview",
        f"- Workflow: `{workflow_id}`",
        f"- Task: `{task_id}`",
        f"- Status: `{status}`",
        f"- Branch: `{branch_name or '-'}`",
        f"- Result commit: `{result_commit or '-'}`",
    ]
    if commit_subject:
        lines.append(f"- Commit subject: {commit_subject}")
    if base_commit:
        lines.append(f"- Base commit: `{base_commit}`")

    lines.extend(["", "## What changed"])
    if summary:
        lines.append(compact_text(summary, 1200))
    elif failure_reason:
        lines.append(compact_text(failure_reason, 1200))
    else:
        lines.append("No additional summary was available.")

    if changed_files:
        lines.extend(["", "Changed files:"])
        lines.extend([f"- `{path}`" for path in changed_files[:15]])
        if len(changed_files) > 15:
            lines.append(f"- ... and {len(changed_files) - 15} more")

    lines.extend(["", "## How to verify / see it"])
    if task_kind == "feature":
        lines.extend([
            "- Start the project and exercise the feature area touched by this task.",
            "- Use the changed files and summary above to locate the new behavior in the app.",
            "- If the task added UI or API behavior, follow the user-visible path described in the task summary.",
        ])
    elif task_kind == "bug-fix":
        lines.extend([
            "- Reproduce the original issue using the scenario described in the task summary or request.",
            "- Re-run the same scenario on this worktree and confirm the broken behavior no longer happens.",
            "- Inspect the changed files above to understand where the fix was applied.",
        ])
    elif task_kind == "internal-change":
        lines.extend([
            "- Run the relevant tests/checks for this area and confirm behavior stays the same.",
            "- Inspect the changed files above to understand the internal restructuring.",
            "- Compare the base and result commits if you want a deeper code-level understanding.",
        ])
    elif task_kind == "failure":
        lines.extend([
            "- This task did not complete successfully.",
            "- Review the failure reason below and inspect the task log if deeper debugging is needed.",
        ])
    elif task_kind == "no-op":
        lines.extend([
            "- No code changes were required for this task.",
            "- Review the summary below to understand why the existing code already satisfied the task.",
        ])
    else:
        lines.extend([
            "- Use the summary and changed files above to inspect the affected code paths.",
            "- Run the relevant checks for this area to confirm the expected behavior.",
            "- Compare the base and result commits if you want a deeper understanding of the implementation.",
        ])

    lines.extend(["", "## Notes"])
    if no_op:
        lines.append("- This task concluded as `no-op`; no code changes were required.")
    if stop_pending:
        lines.append("- This task requested stop-pending; remaining pending tasks may have been cancelled.")
    if failure_reason:
        lines.append(f"- Failure reason: {compact_text(failure_reason, 600)}")
    if not any((no_op, stop_pending, failure_reason)):
        lines.append("- No additional notes.")

    lines.extend([
        "",
        "## Original request context",
        compact_text(workflow_request, 1200) or "(not available)",
    ])

    return "\n".join(lines).rstrip() + "\n"



def write_task_explainer(
    *,
    workflow_id: str,
    workflow_request: str,
    task_id: str,
    task_name: str,
    task_prompt: str,
    branch_name: str,
    worktree: str,
    status: str,
    summary: str,
    failure_reason: str,
    no_op: bool,
    stop_pending: bool,
    base_commit: str,
    result_commit: str,
) -> None:
    """Write the explainer file next to the task's checked-out code."""

    worktree_path = pathlib.Path(worktree)
    filename = explainer_filename(workflow_id, task_id)
    commit_subject = run_git_text(worktree, ["show", "-s", "--format=%s", result_commit]) if result_commit else ""
    changed_files_output = ""
    if result_commit and base_commit and result_commit != base_commit:
        changed_files_output = run_git_text(worktree, ["diff", "--name-only", f"{base_commit}..{result_commit}"])
    elif result_commit:
        changed_files_output = run_git_text(worktree, ["show", "--pretty=", "--name-only", result_commit])
    changed_files = [line.strip() for line in changed_files_output.splitlines() if line.strip()]
    content = build_task_explainer(
        workflow_id=workflow_id,
        workflow_request=workflow_request,
        task_id=task_id,
        task_name=task_name,
        task_prompt=task_prompt,
        branch_name=branch_name,
        status=status,
        summary=summary,
        failure_reason=failure_reason,
        no_op=no_op,
        stop_pending=stop_pending,
        base_commit=base_commit,
        result_commit=result_commit,
        commit_subject=commit_subject,
        changed_files=changed_files,
    )
    (worktree_path / filename).write_text(content, encoding="utf-8")


def main() -> int:
    """Run the task, derive workflow outcome flags, and report the result."""

    parser = argparse.ArgumentParser(description="Run a workflow task via codex exec and finalize state")
    parser.add_argument("--workflow", required=True)
    parser.add_argument("--task-id", required=True)
    args = parser.parse_args()

    workflow = pathlib.Path(args.workflow).expanduser().resolve()
    wf_script = pathlib.Path(__file__).with_name("workflow.py")
    state_script = pathlib.Path(__file__).with_name("session_state.py")

    data, task = load_task(workflow, args.task_id)
    if task is None:
        print("task not found", file=sys.stderr)
        return 1

    worktree = ""
    # Handle small propagation delay between trigger write and runner startup.
    for _ in range(25):
        data, task = load_task(workflow, args.task_id)
        if task is None:
            break
        worktree = str(task.get("worktreePath") or "").strip()
        if worktree:
            break
        time.sleep(0.2)
    if task is None:
        print("task not found", file=sys.stderr)
        return 1
    if not worktree:
        return fail_and_trigger(workflow, wf_script, args.task_id, "task has no worktreePath")

    prompt = str(task.get("prompt") or "").strip()
    if not prompt:
        return fail_and_trigger(workflow, wf_script, args.task_id, "task has empty prompt")
    prompt = (
        f"{prompt}\n\n"
        "Workflow invariants:\n"
        "- Work only in the provided branch/worktree.\n"
        "- Run relevant tests/build checks for your changes.\n"
        "- If you make code changes, commit your final changes with a clear commit message.\n"
        "- If no code changes are required, clearly state `no-op` in the final summary.\n"
        "- Only include `[codex-deck:stop-pending]` in the final summary if completing this task truly makes remaining pending tasks unnecessary.\n"
        "- In the final summary, explain what changed in user-facing terms and how to verify or see it."
    )
    base_commit = str(task.get("baseCommit") or "").strip()
    started_at = str(task.get("startedAt") or "").strip()

    log_dir = workflow.parent / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"{args.task_id}.log"

    settings = data.get("settings", {}) if isinstance(data.get("settings"), dict) else {}
    cmd = codex_command(settings, "exec", prompt)
    command_env = codex_env(settings)
    record_daemon_command(
        workflow,
        source="task-runner",
        task_id=args.task_id,
        cwd=worktree,
        command=cmd,
    )
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=worktree,
            env=command_env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
        )
    except FileNotFoundError:
        return fail_and_trigger(workflow, wf_script, args.task_id, "codex executable not found in PATH")
    except Exception as exc:
        return fail_and_trigger(workflow, wf_script, args.task_id, f"failed to start codex exec: {exc}")

    session_id = ""
    with log_file.open("a", encoding="utf-8") as handle:
        assert proc.stdout is not None
        for line in proc.stdout:
            handle.write(line)
            handle.flush()
            if not session_id:
                match = SESSION_ID_REGEX.search(line)
                if match:
                    session_id = match.group(1)
                    maybe_set_task_session(workflow, wf_script, args.task_id, session_id)

    rc = proc.wait()

    if not session_id:
        data, _ = load_task(workflow, args.task_id)
        codex_home = str(data.get("settings", {}).get("codexHome") or "")
        # stdout parsing is the preferred attachment path; the fallback only runs
        # when codex did not surface a session id directly.
        if codex_home:
            session_id = fallback_latest_session_id(codex_home, started_at, worktree)
            if session_id:
                maybe_set_task_session(workflow, wf_script, args.task_id, session_id)

    summary = ""
    no_op = False
    stop_pending = False
    if session_id:
        data, _ = load_task(workflow, args.task_id)
        codex_home = str(data.get("settings", {}).get("codexHome") or "")
        query = [sys.executable, str(state_script), "--session-id", session_id, "--json"]
        if codex_home:
            query.extend(["--codex-home", codex_home])
        state_rc, state_out = run_cmd(query)
        if state_rc == 0:
            try:
                parsed = json.loads(state_out)
                summary = str(parsed.get("summary") or "")
                no_op = bool(parsed.get("noOp"))
                stop_pending = bool(parsed.get("stopPending"))
            except Exception:
                pass

    commit = ""
    commit_rc, commit_out = run_cmd(["git", "-C", worktree, "rev-parse", "HEAD"])
    if commit_rc == 0:
        commit = commit_out.strip().splitlines()[0].strip()

    success = rc == 0
    failure_reason = f"codex exec exit code {rc}"
    if no_op:
        success = True
        failure_reason = ""
    elif success:
        # A successful worker run is not enough on its own; non-no-op tasks must
        # advance HEAD so the workflow has a concrete result commit to merge.
        if not commit:
            success = False
            failure_reason = "codex exec succeeded but could not resolve task HEAD commit"
        elif base_commit and commit == base_commit:
            success = False
            failure_reason = "codex exec succeeded but task did not create a new commit"
        else:
            failure_reason = ""

    status = "success" if success else "failed"
    try:
        write_task_explainer(
            workflow_id=str(data.get("workflow", {}).get("id") or "workflow"),
            workflow_request=str(data.get("workflow", {}).get("request") or ""),
            task_id=args.task_id,
            task_name=str(task.get("name") or args.task_id),
            task_prompt=prompt,
            branch_name=str(task.get("branchName") or ""),
            worktree=worktree,
            status=status,
            summary=summary,
            failure_reason=failure_reason,
            no_op=no_op,
            stop_pending=stop_pending,
            base_commit=base_commit,
            result_commit=commit,
        )
    except Exception:
        pass

    payload = {
        "taskId": args.task_id,
        "summary": summary,
        "resultCommit": commit,
        "failureReason": failure_reason or f"codex exec exit code {rc}",
        "noOp": no_op,
        "stopPending": stop_pending,
    }
    try:
        notify_daemon(workflow, "task-finished" if success else "task-failed", payload)
    except Exception:
        # Direct finish-task mutation is a resilience fallback for cases where the
        # daemon is gone; it preserves the task outcome even if auto-retriggering
        # cannot happen immediately.
        finish_cmd = [
            sys.executable,
            str(wf_script),
            "finish-task",
            "--workflow",
            str(workflow),
            "--task-id",
            args.task_id,
            "--summary",
            summary,
            "--result-commit",
            commit,
        ]
        if no_op:
            finish_cmd.append("--no-op")
        if stop_pending:
            finish_cmd.append("--stop-pending")
        if success:
            finish_cmd.append("--success")
        else:
            finish_cmd.extend(["--failure-reason", failure_reason or f"codex exec exit code {rc}"])
        subprocess.run(finish_cmd, check=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
