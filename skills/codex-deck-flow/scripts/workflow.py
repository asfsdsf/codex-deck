#!/usr/bin/env python3
"""Core workflow state machine for codex-deck.

This module owns the persisted workflow JSON contract under ``.codex-deck/``.
It is used by both the short-lived operator-facing commands exposed through
``run.sh`` and the long-lived daemon runtime.

The key responsibility here is keeping workflow state transitions explicit and
serializable: validating workflow shape, reconciling stale runtime state,
launching worker tasks in worktrees, composing prompts for the runtime main
agent, and applying task completion mutations reported back by workers or the
background daemon.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time
from typing import Any

SCHEDULER_STALE_SECONDS = 120
MAX_RECENT_OUTCOMES = 5
DEFAULT_TARGET_BRANCH_FALLBACK = "main"
DEFAULT_STOP_SIGNAL = "[codex-deck:stop-pending]"
DEFAULT_CODEX_SANDBOX_MODE = "danger-full-access"
DEFAULT_SCHEDULER_PROMPT = (
    "You are the runtime scheduler for this workflow. "
    "Start each turn by refreshing workflow state: reconcile dead runners, apply stop-signal pruning, and recompute workflow status. "
    "Then inspect status and ready tasks before making scheduling decisions. "
    "Process any active control messages from the operator before deciding whether to edit workflow state or launch more work. "
    "Use only the codex-deck-flow command surface provided in this prompt for orchestration. "
    "Launch tasks only when dependencies are satisfied, branch conflicts are avoided, and workflow capacity allows more running tasks. "
    "Keep merge explicit; do not merge unless the user explicitly asked. "
    "Before finishing the turn, run validate and ensure it succeeds."
)
SESSION_ID_REGEX = re.compile(r"session id:\s*([0-9a-fA-F\-]{36})", re.IGNORECASE)
SESSION_ID_EXACT_REGEX = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
SESSION_ID_SUFFIX_REGEX = re.compile(r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$")
TASK_STATUSES = {"pending", "running", "success", "failed", "cancelled"}
WORKFLOW_STATUSES = {"draft", "running", "completed", "failed", "cancelled"}
DEFAULT_CREATE_SUGGESTION_COUNT = 3


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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


def sanitize_id(value: str) -> str:
    out = "".join(ch.lower() if ch.isalnum() else "-" for ch in value.strip())
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-") or f"workflow-{int(dt.datetime.now().timestamp())}"


def codex_home(explicit: str | None) -> str:
    if explicit and explicit.strip():
        return str(pathlib.Path(explicit).expanduser().resolve())
    env = os.environ.get("CODEX_HOME", "").strip()
    if env:
        return str(pathlib.Path(env).expanduser().resolve())
    return str((pathlib.Path.home() / ".codex").resolve())



def codex_cli_path(explicit: str | None) -> str:
    if explicit and explicit.strip():
        return str(pathlib.Path(explicit).expanduser().resolve())
    env = os.environ.get("CODEX_CLI_PATH", "").strip()
    if env:
        return str(pathlib.Path(env).expanduser().resolve())
    return "codex"



def codex_command(settings: dict[str, Any], *args: str) -> list[str]:
    executable = str(settings.get("codexCliPath") or "").strip() or codex_cli_path(None)
    if args and args[0] == "exec":
        return [executable, "exec", "--sandbox", DEFAULT_CODEX_SANDBOX_MODE, *args[1:]]
    return [executable, "--sandbox", DEFAULT_CODEX_SANDBOX_MODE, *args]



def codex_env(settings: dict[str, Any]) -> dict[str, str]:
    env = os.environ.copy()
    codex_home_value = str(settings.get("codexHome") or "").strip()
    if codex_home_value:
        env["CODEX_HOME"] = codex_home_value
    codex_cli_value = str(settings.get("codexCliPath") or "").strip()
    if codex_cli_value:
        env["CODEX_CLI_PATH"] = codex_cli_value
    return env



def detect_target_branch(project_root: pathlib.Path) -> str:
    commands = [
        ["git", "-C", str(project_root), "branch", "--show-current"],
        ["git", "-C", str(project_root), "symbolic-ref", "--quiet", "--short", "HEAD"],
        ["git", "-C", str(project_root), "rev-parse", "--abbrev-ref", "HEAD"],
    ]
    for cmd in commands:
        try:
            out = subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL).strip()
        except Exception:
            continue
        if out and out != "HEAD":
            return out
    return DEFAULT_TARGET_BRANCH_FALLBACK


def default_task_prompt(user_request: str, task_name: str) -> str:
    return (
        "Workflow context:\n"
        f"- Overall request: {user_request}\n"
        f"- Assigned task: {task_name}\n\n"
        "Execution contract:\n"
        "- Work only on this assigned task in the provided branch/worktree.\n"
        "- Avoid redoing sibling tasks or broad workflow orchestration.\n"
        "- Run relevant tests/build checks for your changes.\n"
        "- Commit your final changes with a clear commit message if you make code changes.\n"
        "- In your final summary, explain what changed in user-facing terms.\n"
        "- If this is a feature, explain how a user can use the project to see it.\n"
        "- If this is a bug fix, explain how to reproduce the old problem and how to verify the fix.\n"
        "- If this is an internal/refactor change, explain what behavior should remain the same and what to inspect.\n"
        "- If no code changes are required, clearly state `no-op` in the final summary.\n"
        f"- Only include `{DEFAULT_STOP_SIGNAL}` in the final summary if completing this task truly makes remaining pending tasks unnecessary."
    )


def load_json(path: pathlib.Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def workflow_registry_dir(codex_home_path: str) -> pathlib.Path:
    directory = pathlib.Path(codex_home_path).expanduser().resolve() / "codex-deck" / "workflows"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def workflow_session_index_dir(codex_home_path: str) -> pathlib.Path:
    directory = workflow_registry_dir(codex_home_path) / "session-index"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def workflow_registry_key(project_root: str, workflow_id: str) -> str:
    normalized_root = str(pathlib.Path(project_root).expanduser().resolve())
    digest = hashlib.sha1(normalized_root.encode("utf-8")).hexdigest()[:12]
    return f"{digest}--{sanitize_id(workflow_id)}"


def summarize_recent_outcomes(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    for task in recent_task_outcomes(tasks):
        summary_text = str(task.get("summary") or "").strip()
        if len(summary_text) > 220:
            summary_text = summary_text[:217].rstrip() + "..."
        summaries.append(
            {
                "taskId": str(task.get("id") or ""),
                "status": str(task.get("status") or ""),
                "resultCommit": str(task.get("resultCommit") or "") or None,
                "failureReason": str(task.get("failureReason") or "") or None,
                "noOp": bool(task.get("noOp")),
                "stopPending": bool(task.get("stopPending")),
                "finishedAt": str(task.get("finishedAt") or "") or None,
                "summary": summary_text or None,
            }
        )
    return summaries


def workflow_session_index_file(codex_home_path: str, session_id: str) -> pathlib.Path:
    safe_name = str(session_id).strip()
    return workflow_session_index_dir(codex_home_path) / f"{safe_name}.json"


def build_workflow_session_index_entries(
    workflow_path: pathlib.Path, payload: dict[str, Any], *, workflow_key: str | None = None
) -> list[dict[str, Any]]:
    workflow = payload.get("workflow", {}) if isinstance(payload.get("workflow"), dict) else {}
    scheduler = payload.get("scheduler", {}) if isinstance(payload.get("scheduler"), dict) else {}
    tasks = [task for task in payload.get("tasks", []) if isinstance(task, dict)]

    project_root = str(workflow.get("projectRoot") or workflow_path.parent.parent)
    workflow_id = str(workflow.get("id") or workflow_path.stem)
    resolved_workflow_path = str(workflow_path.resolve())
    resolved_workflow_key = workflow_key or workflow_registry_key(project_root, workflow_id)
    workflow_title = str(workflow.get("title") or workflow_id)
    updated_at = str(workflow.get("updatedAt") or "") or None

    entries: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add_entry(session_id: Any, entry_type: str, task_id: str | None = None) -> None:
        session_value = str(session_id or "").strip()
        if not session_value or session_value in seen:
            return
        seen.add(session_value)
        entries.append(
            {
                "sessionId": session_value,
                "type": entry_type,
                "workflowKey": resolved_workflow_key,
                "workflowId": workflow_id,
                "workflowTitle": workflow_title,
                "workflowPath": resolved_workflow_path,
                "projectRoot": project_root,
                "taskId": task_id,
                "updatedAt": updated_at,
            }
        )

    add_entry(workflow.get("boundSession"), "bound")
    add_entry(scheduler.get("lastSessionId") or scheduler.get("threadId"), "scheduler")
    for task in tasks:
        task_id = str(task.get("id") or "").strip() or None
        add_entry(task.get("sessionId"), "task", task_id)

    return entries


def summarize_session_index_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "sessionId": str(entry.get("sessionId") or ""),
            "type": str(entry.get("type") or ""),
            "taskId": str(entry.get("taskId") or "") or None,
        }
        for entry in entries
        if str(entry.get("sessionId") or "").strip()
    ]


def load_registry_session_index_entries(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_entries = payload.get("sessionIndex", [])
    if not isinstance(raw_entries, list):
        return []
    entries: list[dict[str, Any]] = []
    for item in raw_entries:
        if not isinstance(item, dict):
            continue
        session_id = str(item.get("sessionId") or "").strip()
        if not session_id:
            continue
        entries.append(
            {
                "sessionId": session_id,
                "type": str(item.get("type") or "").strip() or None,
                "taskId": str(item.get("taskId") or "").strip() or None,
            }
        )
    return entries


def sync_workflow_session_index(
    workflow_path: pathlib.Path,
    codex_home_path: str,
    desired_entries: list[dict[str, Any]],
    previous_entries: list[dict[str, Any]] | None = None,
) -> None:
    workflow_path_value = str(workflow_path.resolve())
    desired_session_ids = {
        str(entry.get("sessionId") or "").strip()
        for entry in desired_entries
        if str(entry.get("sessionId") or "").strip()
    }

    for entry in desired_entries:
        session_id = str(entry.get("sessionId") or "").strip()
        if not session_id:
            continue
        session_path = workflow_session_index_file(codex_home_path, session_id)
        if session_path.exists():
            try:
                existing_payload = load_json(session_path)
            except Exception:
                existing_payload = {}
            existing_workflow_path = str(existing_payload.get("workflowPath") or "").strip()
            if existing_workflow_path and existing_workflow_path != workflow_path_value:
                continue
        session_path.write_text(json.dumps(entry, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")

    for entry in previous_entries or []:
        session_id = str(entry.get("sessionId") or "").strip()
        if not session_id or session_id in desired_session_ids:
            continue
        session_path = workflow_session_index_file(codex_home_path, session_id)
        if not session_path.exists():
            continue
        try:
            existing_payload = load_json(session_path)
        except Exception:
            continue
        if str(existing_payload.get("workflowPath") or "").strip() != workflow_path_value:
            continue
        try:
            session_path.unlink()
        except FileNotFoundError:
            pass


def build_workflow_registry_payload(
    workflow_path: pathlib.Path, payload: dict[str, Any], *, session_index_entries: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    workflow = payload.get("workflow", {}) if isinstance(payload.get("workflow"), dict) else {}
    scheduler = payload.get("scheduler", {}) if isinstance(payload.get("scheduler"), dict) else {}
    settings = payload.get("settings", {}) if isinstance(payload.get("settings"), dict) else {}
    tasks = [task for task in payload.get("tasks", []) if isinstance(task, dict)]

    task_counts = {
        status: sum(1 for task in tasks if str(task.get("status") or "") == status)
        for status in sorted(TASK_STATUSES)
    }
    task_counts["total"] = len(tasks)

    project_root = str(workflow.get("projectRoot") or workflow_path.parent.parent)
    workflow_id = str(workflow.get("id") or workflow_path.stem)
    key = workflow_registry_key(project_root, workflow_id)
    session_index = session_index_entries or build_workflow_session_index_entries(
        workflow_path, payload, workflow_key=key
    )
    workflow_summary = {
        "id": workflow_id,
        "title": str(workflow.get("title") or workflow_id),
        "status": str(workflow.get("status") or "draft"),
        "projectRoot": project_root,
        "targetBranch": str(workflow.get("targetBranch") or "") or None,
        "updatedAt": str(workflow.get("updatedAt") or "") or None,
        "createdAt": str(workflow.get("createdAt") or "") or None,
        "request": str(workflow.get("request") or "") or None,
    }
    bound_session = str(workflow.get("boundSession") or "").strip()
    if bound_session:
        workflow_summary["boundSession"] = bound_session

    return {
        "key": key,
        "workflowPath": str(workflow_path.resolve()),
        "workflow": workflow_summary,
        "scheduler": {
            "running": bool(scheduler.get("running")),
            "pendingTrigger": bool(scheduler.get("pendingTrigger")),
            "lastSessionId": str(scheduler.get("lastSessionId") or "") or None,
            "threadId": str(scheduler.get("threadId") or "") or None,
            "lastReason": str(scheduler.get("lastReason") or "") or None,
            "lastRunAt": str(scheduler.get("lastRunAt") or "") or None,
            "lastTurnStatus": str(scheduler.get("lastTurnStatus") or "") or None,
        },
        "settings": {
            "codexHome": str(settings.get("codexHome") or "") or None,
            "maxParallel": int(settings.get("maxParallel") or 0) if str(settings.get("maxParallel") or "").strip() else None,
            "mergePolicy": str(settings.get("mergePolicy") or "") or None,
        },
        "sessionIndex": summarize_session_index_entries(session_index),
        "taskCounts": task_counts,
        "recentOutcomes": summarize_recent_outcomes(tasks),
    }


def sync_workflow_registry(workflow_path: pathlib.Path, payload: dict[str, Any]) -> None:
    settings = payload.get("settings", {}) if isinstance(payload.get("settings"), dict) else {}
    codex_home_value = codex_home(str(settings.get("codexHome") or "") or None)
    registry_dir = workflow_registry_dir(codex_home_value)
    workflow = payload.get("workflow", {}) if isinstance(payload.get("workflow"), dict) else {}
    workflow_id = str(workflow.get("id") or workflow_path.stem)
    project_root = str(workflow.get("projectRoot") or workflow_path.parent.parent)
    registry_key = workflow_registry_key(project_root, workflow_id)
    registry_path = registry_dir / f"{registry_key}.json"
    previous_registry_payload: dict[str, Any] = {}
    if registry_path.exists():
        try:
            previous_registry_payload = load_json(registry_path)
        except Exception:
            previous_registry_payload = {}
    session_index_entries = build_workflow_session_index_entries(
        workflow_path, payload, workflow_key=registry_key
    )
    sync_workflow_session_index(
        workflow_path,
        codex_home_value,
        session_index_entries,
        previous_entries=load_registry_session_index_entries(previous_registry_payload),
    )
    registry_payload = build_workflow_registry_payload(
        workflow_path, payload, session_index_entries=session_index_entries
    )
    registry_path.write_text(json.dumps(registry_payload, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")


def write_json(path: pathlib.Path, payload: dict[str, Any]) -> None:
    payload.setdefault("workflow", {})
    payload["workflow"]["updatedAt"] = now_iso()
    text = json.dumps(payload, ensure_ascii=True, indent=2) + "\n"
    path.write_text(text, encoding="utf-8")
    sync_workflow_registry(path, payload)


def workflow_file(project_root: pathlib.Path, workflow_id: str, *, ensure_dir: bool = True) -> pathlib.Path:
    flow_dir = project_root / ".codex-deck"
    if ensure_dir:
        flow_dir.mkdir(parents=True, exist_ok=True)
    return flow_dir / f"{sanitize_id(workflow_id)}.json"


def suggest_workflow_ids(
    project_root: pathlib.Path, workflow_id: str, *, limit: int = DEFAULT_CREATE_SUGGESTION_COUNT
) -> list[tuple[str, pathlib.Path]]:
    requested_id = sanitize_id(workflow_id)
    suggestions: list[tuple[str, pathlib.Path]] = []
    suffix = 2
    while len(suggestions) < max(limit, 1):
        candidate_id = f"{requested_id}-{suffix}"
        candidate_path = workflow_file(project_root, candidate_id)
        if not candidate_path.exists():
            suggestions.append((candidate_id, candidate_path))
        suffix += 1
    return suggestions


def build_create_conflict_payload(project_root: pathlib.Path, workflow_id: str) -> dict[str, Any]:
    requested_id = sanitize_id(workflow_id)
    conflicting_path = workflow_file(project_root, requested_id)
    suggestions = suggest_workflow_ids(project_root, requested_id)
    suggested_ids = [candidate_id for candidate_id, _candidate_path in suggestions]
    suggested_path = str(suggestions[0][1]) if suggestions else None
    return {
        "ok": False,
        "error": "workflow-id-conflict",
        "requestedId": requested_id,
        "conflictingPath": str(conflicting_path),
        "suggestedIds": suggested_ids,
        "suggestedPath": suggested_path,
    }


def print_create_conflict(payload: dict[str, Any], *, json_output: bool) -> None:
    if json_output:
        print(json.dumps(payload, ensure_ascii=True))
        return
    print(f"error: workflow already exists: {payload['conflictingPath']}", file=sys.stderr)
    print(f"requested workflow id: {payload['requestedId']}", file=sys.stderr)
    if payload.get("suggestedIds"):
        print(f"suggested workflow id: {payload['suggestedIds'][0]}", file=sys.stderr)
    if payload.get("suggestedPath"):
        print(f"suggested workflow path: {payload['suggestedPath']}", file=sys.stderr)
    remaining_ids = payload.get("suggestedIds", [])[1:]
    if remaining_ids:
        print(f"other suggested workflow ids: {', '.join(remaining_ids)}", file=sys.stderr)


def workflow_registry_file(project_root: pathlib.Path, workflow_id: str, codex_home_path: str | None = None) -> pathlib.Path:
    codex_home_value = codex_home(codex_home_path)
    key = workflow_registry_key(str(project_root), workflow_id)
    return workflow_registry_dir(codex_home_value) / f"{key}.json"


def resolve_workflow_path(
    project_root: pathlib.Path, workflow_id: str, codex_home_path: str | None = None
) -> tuple[pathlib.Path, str]:
    canonical_path = workflow_file(project_root, workflow_id, ensure_dir=False).resolve()
    if canonical_path.is_file():
        return canonical_path, "canonical"

    registry_path = workflow_registry_file(project_root, workflow_id, codex_home_path)
    if registry_path.is_file():
        try:
            registry_payload = load_json(registry_path)
        except Exception:
            registry_payload = {}
        workflow_path_text = str(registry_payload.get("workflowPath") or "").strip()
        if workflow_path_text:
            registry_candidate = pathlib.Path(workflow_path_text).expanduser().resolve()
            if registry_candidate.is_file():
                return registry_candidate, "registry"

    return canonical_path, "missing"


def with_lock(lock_path: pathlib.Path):
    import fcntl

    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+", encoding="utf-8")
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    return handle


def append_history(data: dict[str, Any], kind: str, details: dict[str, Any] | None = None) -> None:
    entry = {"at": now_iso(), "type": kind, "details": details or {}}
    data.setdefault("history", []).append(entry)


def summarize_daemon_command_for_history(command: list[str]) -> dict[str, str] | None:
    """Return a compact summary for codex exec/resume commands only."""

    normalized = [str(part) for part in command]
    if not normalized:
        return None

    executable = pathlib.Path(normalized[0]).name or normalized[0]

    # direct CLI exec path, e.g. codex exec --sandbox danger-full-access <prompt>
    if len(normalized) >= 2 and normalized[1] == "exec":
        sandbox_mode = ""
        for index, value in enumerate(normalized):
            if value == "--sandbox" and index + 1 < len(normalized):
                sandbox_mode = normalized[index + 1]
                break
        summary = f"{executable} exec"
        if sandbox_mode:
            summary += f" --sandbox {sandbox_mode}"
        summary += " <prompt>"
        return {"commandType": "exec", "commandSummary": summary}

    # scheduler continuity helper path, e.g. python codex_resume_noninteractive.py <session> <prompt> ...
    if len(normalized) >= 2:
        helper_name = pathlib.Path(normalized[1]).name
        if helper_name == "codex_resume_noninteractive.py":
            session_id = normalized[2] if len(normalized) >= 3 else "<session-id>"
            summary = f"codex resume {session_id} <prompt> --sandbox danger-full-access (noninteractive helper)"
            return {"commandType": "resume", "commandSummary": summary}

    return None


def extract_session_id_from_command(command: list[str]) -> str:
    """Return the first UUID-like session id argument from a command."""

    for part in command:
        token = str(part or "").strip()
        if SESSION_ID_EXACT_REGEX.fullmatch(token):
            return token
    return ""


def append_daemon_command_history(
    workflow_path: pathlib.Path,
    *,
    source: str,
    command: list[str],
    cwd: pathlib.Path | str | None = None,
    task_id: str | None = None,
) -> None:
    """Record one daemon-owned command so browser clients can trace execution."""

    lock_path = workflow_path.with_suffix(".lock")
    command_info = summarize_daemon_command_for_history(command)
    if command_info is None:
        return
    try:
        with with_lock(lock_path):
            data = load_json(workflow_path)
            scheduler = data.get("scheduler")
            if not isinstance(scheduler, dict):
                return
            if str(scheduler.get("controllerMode") or "direct") != "daemon":
                return
            append_history(
                data,
                "daemon_command_executed",
                {
                    "source": source,
                    "taskId": task_id or None,
                    "cwd": str(cwd) if cwd else None,
                    "commandType": command_info["commandType"],
                    "commandSummary": command_info["commandSummary"],
                },
            )
            write_json(workflow_path, data)
    except Exception:
        # Command tracing must stay best-effort and never break orchestration.
        return


def set_scheduler_active_command(
    workflow_path: pathlib.Path,
    *,
    pid: int | None,
    command: list[str] | None = None,
) -> None:
    """Track the currently running scheduler command process in workflow state."""

    lock_path = workflow_path.with_suffix(".lock")
    with with_lock(lock_path):
        data = load_json(workflow_path)
        scheduler = data.get("scheduler")
        if not isinstance(scheduler, dict):
            return
        controller = scheduler.setdefault("controller", {})
        if not isinstance(controller, dict):
            controller = {}
            scheduler["controller"] = controller
        if isinstance(pid, int) and pid > 0:
            controller["activeCommandPid"] = pid
            controller["activeCommandStartedAt"] = now_iso()
            command_info = summarize_daemon_command_for_history(command or [])
            command_session_id = extract_session_id_from_command(command or [])
            controller["activeCommandType"] = (
                str(command_info.get("commandType") or "").strip()
                if command_info
                else "command"
            )
            controller["activeCommandSummary"] = (
                str(command_info.get("commandSummary") or "").strip()
                if command_info
                else "scheduler command"
            )
            controller["activeCommandSessionId"] = command_session_id or None
        else:
            controller["activeCommandPid"] = None
            controller["activeCommandStartedAt"] = None
            controller["activeCommandType"] = None
            controller["activeCommandSummary"] = None
            controller["activeCommandSessionId"] = None
        write_json(workflow_path, data)


def process_is_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def task_terminal(status: str | None) -> bool:
    return str(status) in {"success", "failed", "cancelled"}


def task_map(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(t.get("id")): t for t in data.get("tasks", []) if isinstance(t, dict)}


def task_ready(task: dict[str, Any], by_id: dict[str, dict[str, Any]]) -> bool:
    if task.get("status") != "pending":
        return False
    deps = task.get("dependsOn", [])
    for dep in deps:
        dep_task = by_id.get(dep)
        if not dep_task or dep_task.get("status") != "success":
            return False
    return True



def task_requested_stop(task: dict[str, Any], stop_signal: str) -> bool:
    if bool(task.get("stopPending")):
        return True
    if not stop_signal:
        return False
    summary = str(task.get("summary") or "").lower()
    return stop_signal in summary



def recent_task_outcomes(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    finished = [
        task
        for task in tasks
        if isinstance(task, dict) and str(task.get("status") or "") in {"success", "failed", "cancelled"}
    ]
    finished.sort(key=lambda item: str(item.get("finishedAt") or ""), reverse=True)
    return finished[:MAX_RECENT_OUTCOMES]


def get_task(data: dict[str, Any], task_id: str) -> dict[str, Any] | None:
    for t in data.get("tasks", []):
        if isinstance(t, dict) and t.get("id") == task_id:
            return t
    return None


def mark_task_failed(data: dict[str, Any], task: dict[str, Any], reason: str) -> None:
    if task_terminal(str(task.get("status"))):
        return
    task["status"] = "failed"
    task["failureReason"] = reason
    task["finishedAt"] = task.get("finishedAt") or now_iso()
    task["runnerPid"] = None
    append_history(data, "task_failed", {"taskId": str(task.get("id") or ""), "reason": reason})


def reconcile_running_tasks(data: dict[str, Any]) -> bool:
    changed = False
    for task in data.get("tasks", []):
        if not isinstance(task, dict):
            continue
        if task.get("status") != "running":
            continue
        pid_raw = task.get("runnerPid")
        pid: int | None = None
        if isinstance(pid_raw, int):
            pid = pid_raw
        elif isinstance(pid_raw, str) and pid_raw.strip().isdigit():
            pid = int(pid_raw.strip())
        if pid is None:
            continue
        if process_is_alive(pid):
            continue
        mark_task_failed(data, task, f"runner process {pid} is no longer running")
        append_history(data, "task_runner_reconciled", {"taskId": task.get("id"), "runnerPid": pid})
        changed = True
    return changed


def apply_stop_signal_pruning(data: dict[str, Any]) -> bool:
    stop_signal = str(data.get("settings", {}).get("stopSignal") or DEFAULT_STOP_SIGNAL).strip().lower()
    if not stop_signal:
        return False
    should_prune = False
    for task in data.get("tasks", []):
        if not isinstance(task, dict):
            continue
        if task.get("status") != "success":
            continue
        if task_requested_stop(task, stop_signal):
            should_prune = True
            break
    if not should_prune:
        return False
    changed = False
    for task in data.get("tasks", []):
        if not isinstance(task, dict):
            continue
        if task.get("status") == "pending":
            task["status"] = "cancelled"
            task["finishedAt"] = now_iso()
            task["failureReason"] = f"Cancelled because previous task requested stop via {stop_signal}."
            changed = True
    if changed:
        append_history(data, "workflow_pruned_stop_signal", {"stopSignal": stop_signal})
    return changed


def build_task_from_mutation(data: dict[str, Any], task_payload: dict[str, Any]) -> dict[str, Any]:
    """Build one validated pending task record from a control-message payload."""

    workflow = data.get("workflow", {})
    workflow_id = sanitize_id(str(workflow.get("id") or "workflow"))
    task_id_raw = str(task_payload.get("id") or "").strip()
    if not task_id_raw:
        raise ValueError("add-task requires payload.task.id")
    task_id = sanitize_id(task_id_raw)

    depends_raw = task_payload.get("dependsOn", [])
    if depends_raw is None:
        depends_raw = []
    if not isinstance(depends_raw, list):
        raise ValueError("add-task payload.task.dependsOn must be an array")

    known_ids = {
        str(task.get("id") or "")
        for task in data.get("tasks", [])
        if isinstance(task, dict) and str(task.get("id") or "").strip()
    }
    depends: list[str] = []
    seen: set[str] = set()
    for dep in depends_raw:
        dep_id = sanitize_id(str(dep))
        if not dep_id:
            continue
        if dep_id == task_id:
            raise ValueError("add-task payload.task.dependsOn cannot include its own id")
        if dep_id not in known_ids:
            raise ValueError(f"add-task dependency not found: {dep_id}")
        if dep_id in seen:
            continue
        seen.add(dep_id)
        depends.append(dep_id)

    name = str(task_payload.get("name") or task_id).strip() or task_id
    prompt = str(task_payload.get("prompt") or "").strip()
    if not prompt:
        prompt = default_task_prompt(str(workflow.get("request") or ""), name)

    branch_name = str(task_payload.get("branchName") or f"flow/{workflow_id}/{task_id}").strip()
    if not branch_name:
        branch_name = f"flow/{workflow_id}/{task_id}"

    return {
        "id": task_id,
        "name": name,
        "prompt": prompt,
        "dependsOn": depends,
        "status": "pending",
        "sessionId": None,
        "branchName": branch_name,
        "worktreePath": None,
        "baseCommit": None,
        "resultCommit": None,
        "startedAt": None,
        "finishedAt": None,
        "summary": None,
        "failureReason": None,
        "noOp": False,
        "stopPending": False,
        "runnerPid": None,
    }


def apply_workflow_mutation(data: dict[str, Any], payload: dict[str, Any], *, request_id: str = "") -> bool:
    """Apply one supported workflow mutation payload in-place.

    Returns True when the mutation type is recognized and applied, False when
    the payload type is unknown and should stay queued as a generic control
    message for manual/operator handling.
    """

    mutation_type = str(payload.get("type") or "").strip().lower()
    if mutation_type != "add-task":
        return False

    task_payload = payload.get("task")
    if not isinstance(task_payload, dict):
        raise ValueError("add-task requires payload.task object")

    task_id = sanitize_id(str(task_payload.get("id") or ""))
    if not task_id:
        raise ValueError("add-task requires payload.task.id")

    already_present = bool(get_task(data, task_id))
    if not already_present:
        task = build_task_from_mutation(data, task_payload)
        data.setdefault("tasks", []).append(task)
    else:
        task = {"id": task_id}

    workflow = data.setdefault("workflow", {})
    if (not already_present) and str(workflow.get("status") or "") in {"completed", "failed", "cancelled"}:
        workflow["status"] = "running"

    append_history(
        data,
        "workflow_mutation_applied",
        {
            "requestId": request_id or None,
            "type": "add-task",
            "taskId": task["id"],
            "alreadyPresent": already_present,
        },
    )
    return True


def compute_workflow_status(data: dict[str, Any]) -> str | None:
    statuses = {str(t.get("status")) for t in data.get("tasks", []) if isinstance(t, dict)}
    if not statuses:
        return None
    if statuses.issubset({"success", "failed", "cancelled"}):
        if "failed" in statuses:
            return "failed"
        if "cancelled" in statuses and "success" not in statuses:
            return "cancelled"
        return "completed"
    return None


def resolve_base_commit(data: dict[str, Any], task: dict[str, Any]) -> str:
    """Choose the commit a task worktree should branch from.

    Dependent tasks inherit from the first dependency's result commit so that
    sequential chains build on prior workflow output. Independent tasks fall
    back to the workflow target branch so they can run in parallel from a
    stable shared base.
    """

    deps = [d for d in task.get("dependsOn", []) if isinstance(d, str)]
    by_id = task_map(data)
    if deps:
        first = by_id[deps[0]]
        commit = str(first.get("resultCommit") or "").strip()
        if commit:
            return commit
    root = pathlib.Path(data["workflow"]["projectRoot"])
    target = str(data["workflow"]["targetBranch"])
    out = subprocess.check_output(["git", "-C", str(root), "rev-parse", target], text=True)
    return out.strip()


def task_depends_on(task_id: str, dep_id: str, by_id: dict[str, dict[str, Any]]) -> bool:
    """Return whether task_id transitively depends on dep_id."""

    if task_id == dep_id or task_id not in by_id or dep_id not in by_id:
        return False

    stack = [task_id]
    seen: set[str] = set()
    while stack:
        current = stack.pop()
        if current in seen:
            continue
        seen.add(current)
        task = by_id.get(current)
        if not task:
            continue
        for raw_dep in task.get("dependsOn", []):
            current_dep = str(raw_dep)
            if current_dep == dep_id:
                return True
            if current_dep in by_id:
                stack.append(current_dep)
    return False


def list_git_worktrees(root: pathlib.Path) -> list[dict[str, str]]:
    """Parse `git worktree list --porcelain` into simple path/branch records."""

    out = subprocess.check_output(["git", "-C", str(root), "worktree", "list", "--porcelain"], text=True)
    entries: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for raw_line in out.splitlines():
        line = raw_line.strip()
        if line.startswith("worktree "):
            if current:
                entries.append(current)
            current = {"path": line[len("worktree ") :].strip(), "branch": ""}
            continue
        if current is None:
            continue
        if line.startswith("branch "):
            current["branch"] = line[len("branch ") :].strip()
    if current:
        entries.append(current)
    return entries


def worktree_branch_ref(branch_name: str) -> str:
    text = branch_name.strip()
    if not text:
        return ""
    if text.startswith("refs/"):
        return text
    return f"refs/heads/{text}"


def release_reused_branch_worktree(root: pathlib.Path, data: dict[str, Any], task: dict[str, Any]) -> None:
    """Detach a completed predecessor worktree when a branch is intentionally reused.

    Shared-branch workflows are valid only when tasks are dependency-ordered.
    In that case the next task needs the same branch name, but git still forbids
    one branch from being attached to two worktrees simultaneously. This helper
    removes the predecessor's finished worktree so the next task can reattach
    the shared branch at its own deterministic worktree path.
    """

    branch_name = str(task.get("branchName") or "").strip()
    if not branch_name:
        return

    attached_path = ""
    branch_ref = worktree_branch_ref(branch_name)
    for entry in list_git_worktrees(root):
        if entry.get("branch") == branch_ref:
            attached_path = entry.get("path", "").strip()
            break
    if not attached_path:
        return

    desired_path = (root / ".codex-deck" / "worktrees" / sanitize_id(str(task.get("id") or ""))).resolve()
    attached_resolved = pathlib.Path(attached_path).resolve()
    if attached_resolved == desired_path:
        return

    by_id = task_map(data)
    task_id = str(task.get("id") or "")
    owners: list[dict[str, Any]] = []
    for other in data.get("tasks", []):
        if not isinstance(other, dict):
            continue
        if str(other.get("branchName") or "").strip() != branch_name:
            continue
        worktree_path = str(other.get("worktreePath") or "").strip()
        if not worktree_path:
            continue
        if pathlib.Path(worktree_path).expanduser().resolve() == attached_resolved:
            owners.append(other)

    if not owners:
        raise RuntimeError(
            f"branch {branch_name} is already attached to non-workflow worktree {attached_resolved}"
        )

    for owner in owners:
        owner_id = str(owner.get("id") or "")
        owner_status = str(owner.get("status") or "")
        if owner_status == "running":
            raise RuntimeError(f"branch {branch_name} is still attached to running task {owner_id}")
        if owner_id != task_id and not task_depends_on(task_id, owner_id, by_id):
            raise RuntimeError(
                f"task {task_id} cannot reuse branch {branch_name} from {owner_id} without depending on it"
            )

    subprocess.check_call(["git", "-C", str(root), "worktree", "remove", "--force", str(attached_resolved)])


def ensure_worktree(root: pathlib.Path, task: dict[str, Any], base_commit: str) -> str:
    """Create a fresh worktree for the task from the chosen base commit."""

    branch = str(task["branchName"])
    wt_dir = root / ".codex-deck" / "worktrees" / sanitize_id(str(task["id"]))
    wt_dir.parent.mkdir(parents=True, exist_ok=True)

    # Each task gets a deterministic worktree path so the daemon and follow-up
    # inspection tools can find it later. Remove any stale directory first so
    # relaunching a task does not inherit leftover checkout state.
    if wt_dir.exists():
        subprocess.run(["git", "-C", str(root), "worktree", "remove", "--force", str(wt_dir)], check=False)

    subprocess.check_call(["git", "-C", str(root), "worktree", "add", "-B", branch, str(wt_dir), base_commit])
    return str(wt_dir)


def run_task_runner(workflow_path: pathlib.Path, task_id: str) -> int:
    cmd = [
        sys.executable,
        str(pathlib.Path(__file__).with_name("task_runner.py")),
        "--workflow",
        str(workflow_path),
        "--task-id",
        task_id,
    ]
    append_daemon_command_history(
        workflow_path,
        source="task-launcher",
        command=cmd,
        cwd=workflow_path.parent.parent,
        task_id=task_id,
    )
    proc = subprocess.Popen(cmd, start_new_session=True)
    return proc.pid


def validate_workflow_data(data: dict[str, Any]) -> list[str]:
    """Validate the persisted workflow JSON shape and runtime invariants.

    The workflow file is the source of truth shared by the skill, daemon, and
    task runners, so this check stays strict about structure and the minimal
    state required for tasks that are already marked running.
    """

    errors: list[str] = []

    workflow = data.get("workflow")
    scheduler_state = data.get("scheduler")
    settings = data.get("settings")
    tasks = data.get("tasks")

    if not isinstance(workflow, dict):
        errors.append("workflow must be an object")
    if not isinstance(scheduler_state, dict):
        errors.append("scheduler must be an object")
    if not isinstance(settings, dict):
        errors.append("settings must be an object")
    if not isinstance(tasks, list):
        errors.append("tasks must be an array")

    if errors:
        return errors

    workflow_status = str(workflow.get("status") or "")
    if workflow_status not in WORKFLOW_STATUSES:
        errors.append(f"workflow.status must be one of {sorted(WORKFLOW_STATUSES)}")

    controller_mode = str(scheduler_state.get("controllerMode") or "direct")
    if controller_mode not in {"direct", "daemon"}:
        errors.append("scheduler.controllerMode must be 'direct' or 'daemon'")
    controller = scheduler_state.get("controller")
    if controller is not None and not isinstance(controller, dict):
        errors.append("scheduler.controller must be an object when present")
    max_parallel = settings.get("maxParallel")
    if not isinstance(max_parallel, int) or max_parallel < 1:
        errors.append("settings.maxParallel must be an integer >= 1")

    ids: list[str] = []
    for idx, task in enumerate(tasks):
        if not isinstance(task, dict):
            errors.append(f"tasks[{idx}] must be an object")
            continue
        task_id = str(task.get("id") or "").strip()
        if not task_id:
            errors.append(f"tasks[{idx}].id is required")
            continue
        ids.append(task_id)

    if len(ids) != len(set(ids)):
        errors.append("task ids must be unique")

    by_id = {str(task.get("id")): task for task in tasks if isinstance(task, dict) and task.get("id")}

    for task_id, task in by_id.items():
        status = str(task.get("status") or "")
        if status not in TASK_STATUSES:
            errors.append(f"task {task_id} has invalid status {status!r}")

        deps = task.get("dependsOn")
        if not isinstance(deps, list):
            errors.append(f"task {task_id} dependsOn must be an array")
            deps = []
        for dep in deps:
            dep_id = str(dep)
            if dep_id not in by_id:
                errors.append(f"task {task_id} dependsOn missing task {dep_id}")
            if dep_id == task_id:
                errors.append(f"task {task_id} cannot depend on itself")

        if status == "running":
            if not str(task.get("worktreePath") or "").strip():
                errors.append(f"task {task_id} is running but worktreePath is empty")
            pid = task.get("runnerPid")
            if not isinstance(pid, int) or pid <= 0:
                errors.append(f"task {task_id} is running but runnerPid is invalid")
            if not str(task.get("startedAt") or "").strip():
                errors.append(f"task {task_id} is running but startedAt is empty")

    branch_to_task_ids: dict[str, list[str]] = {}
    for task_id, task in by_id.items():
        branch_name = str(task.get("branchName") or "").strip()
        if branch_name:
            branch_to_task_ids.setdefault(branch_name, []).append(task_id)

    for branch_name, task_ids in sorted(branch_to_task_ids.items()):
        if len(task_ids) < 2:
            continue
        running_on_branch = [task_id for task_id in task_ids if str(by_id[task_id].get("status") or "") == "running"]
        if len(running_on_branch) > 1:
            errors.append(
                f"branch {branch_name} is used by multiple running tasks: {', '.join(sorted(running_on_branch))}"
            )
        for idx, left_id in enumerate(task_ids):
            for right_id in task_ids[idx + 1 :]:
                if task_depends_on(left_id, right_id, by_id) or task_depends_on(right_id, left_id, by_id):
                    continue
                errors.append(
                    f"tasks {left_id} and {right_id} share branch {branch_name} but are not ordered by dependencies"
                )

    visiting: set[str] = set()
    visited: set[str] = set()

    def dfs(node: str) -> None:
        if node in visited or node in visiting:
            return
        visiting.add(node)
        task = by_id[node]
        for dep in task.get("dependsOn", []):
            dep_id = str(dep)
            if dep_id not in by_id:
                continue
            if dep_id in visiting:
                errors.append(f"cycle detected: {dep_id} -> {node}")
                continue
            dfs(dep_id)
        visiting.remove(node)
        visited.add(node)

    for task_id in by_id:
        dfs(task_id)

    return errors


def cmd_validate(args: argparse.Namespace) -> int:
    wf_path = pathlib.Path(args.workflow).expanduser().resolve()
    data = load_json(wf_path)
    errors = validate_workflow_data(data)
    if args.json:
        print(json.dumps({"valid": not errors, "errors": errors}, ensure_ascii=True))
    else:
        if not errors:
            print("valid")
        else:
            print("invalid")
            for err in errors:
                print(f"- {err}")
    return 0 if not errors else 1


def refresh_workflow_state(data: dict[str, Any], reason: str = "") -> bool:
    """Reconcile runtime-derived state back into the persisted workflow record."""

    changed = reconcile_running_tasks(data)
    # Stop-signal pruning only cancels still-pending work; completed and running
    # tasks keep their recorded outcome so the daemon can explain why pruning
    # happened after the fact.
    changed = apply_stop_signal_pruning(data) or changed
    status = compute_workflow_status(data)
    if status and data.get("workflow", {}).get("status") != status:
        data["workflow"]["status"] = status
        changed = True
    if changed:
        details = {"reason": reason} if reason else {}
        append_history(data, "workflow_reconciled", details)
    return changed


def update_scheduler_controller(data: dict[str, Any], **fields: Any) -> None:
    scheduler_state = data.setdefault("scheduler", {})
    controller = scheduler_state.setdefault("controller", {})
    for key, value in fields.items():
        controller[key] = value
    if controller.get("daemonPid") is None and controller.get("daemonId") in {None, ""}:
        controller.pop("daemonScope", None)


def cmd_reconcile(args: argparse.Namespace) -> int:
    wf_path = pathlib.Path(args.workflow).expanduser().resolve()
    lock_path = wf_path.with_suffix(".lock")
    with with_lock(lock_path):
        data = load_json(wf_path)
        refresh_workflow_state(data)
        write_json(wf_path, data)
    print("ok")
    return 0


def ready_tasks(data: dict[str, Any]) -> list[dict[str, Any]]:
    by_id = task_map(data)
    return [t for t in data.get("tasks", []) if isinstance(t, dict) and task_ready(t, by_id)]


def cmd_ready_tasks(args: argparse.Namespace) -> int:
    wf_path = pathlib.Path(args.workflow).expanduser().resolve()
    data = load_json(wf_path)
    errors = validate_workflow_data(data)
    if errors:
        print("error: invalid workflow state", file=sys.stderr)
        for err in errors:
            print(f"- {err}", file=sys.stderr)
        return 1
    ready = ready_tasks(data)
    payload = [
        {
            "id": str(task.get("id") or ""),
            "name": str(task.get("name") or ""),
            "branchName": str(task.get("branchName") or ""),
            "dependsOn": [str(v) for v in task.get("dependsOn", []) if str(v).strip()],
        }
        for task in ready
    ]
    if args.json:
        print(json.dumps(payload, ensure_ascii=True))
    else:
        for item in payload:
            deps = ",".join(item["dependsOn"]) if item["dependsOn"] else "-"
            print(f"{item['id']}\tdeps={deps}\tbranch={item['branchName']}")
    return 0


def cmd_launch_task(args: argparse.Namespace) -> int:
    """Launch one dependency-ready task in its own git worktree and runner."""

    wf_path = pathlib.Path(args.workflow).expanduser().resolve()
    lock_path = wf_path.with_suffix(".lock")

    with with_lock(lock_path):
        data = load_json(wf_path)
        errors = validate_workflow_data(data)
        if errors:
            print("error: invalid workflow state", file=sys.stderr)
            for err in errors:
                print(f"- {err}", file=sys.stderr)
            return 1

        task = get_task(data, args.task_id)
        if not task:
            print(f"error: task not found: {args.task_id}", file=sys.stderr)
            return 1
        if task.get("status") != "pending":
            print(f"error: task {args.task_id} is not pending", file=sys.stderr)
            return 1

        by_id = task_map(data)
        if not task_ready(task, by_id):
            print(f"error: task {args.task_id} dependencies are not satisfied", file=sys.stderr)
            return 1

        running_tasks = [
            other
            for other in data.get("tasks", [])
            if isinstance(other, dict) and other.get("status") == "running"
        ]
        # maxParallel and per-branch exclusivity are the two safeguards that
        # keep multiple worker sessions from trampling the same logical work.
        max_parallel = int(data.get("settings", {}).get("maxParallel") or 1)
        if len(running_tasks) >= max_parallel:
            print(
                f"error: workflow already has {len(running_tasks)} running task(s), reaching maxParallel={max_parallel}",
                file=sys.stderr,
            )
            return 1

        branch = str(task.get("branchName") or "")
        for other in running_tasks:
            if str(other.get("branchName") or "") == branch:
                print(f"error: another running task already uses branch {branch}", file=sys.stderr)
                return 1

        if data["workflow"].get("status") == "draft":
            data["workflow"]["status"] = "running"

        root = pathlib.Path(data["workflow"]["projectRoot"])
        base = resolve_base_commit(data, task)
        try:
            release_reused_branch_worktree(root, data, task)
            wt = ensure_worktree(root, task, base)
        except Exception as exc:
            print(f"error: failed to prepare task worktree: {exc}", file=sys.stderr)
            return 1

        task["baseCommit"] = base
        task["worktreePath"] = wt
        task["status"] = "running"
        task["sessionId"] = None
        task["finishedAt"] = None
        task["failureReason"] = None
        task["summary"] = None
        task["resultCommit"] = None
        task["noOp"] = False
        task["stopPending"] = False
        task["startedAt"] = now_iso()
        task["runnerPid"] = None

        write_json(wf_path, data)

        try:
            pid = run_task_runner(wf_path, str(task["id"]))
        except Exception as exc:
            mark_task_failed(data, task, f"failed to start task runner: {exc}")
            write_json(wf_path, data)
            print(f"error: failed to start task runner: {exc}", file=sys.stderr)
            return 1

        task["runnerPid"] = pid
        append_history(data, "tasks_started", {"taskIds": [str(task["id"])]})
        write_json(wf_path, data)

    print(f"launched {args.task_id} pid={pid}")
    return 0


def extract_session_id(output: str) -> str:
    match = SESSION_ID_REGEX.search(output)
    return match.group(1) if match else ""


def compose_scheduler_prompt(data: dict[str, Any], reason: str, workflow_path: pathlib.Path, run_sh: pathlib.Path) -> str:
    """Render the scheduler prompt for one daemon-owned scheduling turn.

    The prompt intentionally exposes only the supported codex-deck command
    surface so the runtime scheduler cannot drift into ad-hoc orchestration.
    """

    workflow = data.get("workflow", {})
    scheduler_state = data.get("scheduler", {})
    settings = data.get("settings", {})
    tasks = data.get("tasks", [])
    ready = ready_tasks(data)
    ready_ids = [str(t.get("id") or "") for t in ready]
    running_tasks = [
        str(task.get("id") or "")
        for task in tasks
        if isinstance(task, dict) and task.get("status") == "running"
    ]
    control_messages = [
        item
        for item in scheduler_state.get("controlMessages", [])
        if isinstance(item, dict)
    ]

    task_lines: list[str] = []
    for task in tasks:
        if not isinstance(task, dict):
            continue
        task_lines.append(
            f"- {task.get('id')}: status={task.get('status')} deps={','.join(task.get('dependsOn', [])) or '-'} session={task.get('sessionId') or '-'} branch={task.get('branchName') or '-'}"
        )

    outcome_lines: list[str] = []
    for task in recent_task_outcomes(tasks):
        summary = " ".join(str(task.get("summary") or "").split())
        if len(summary) > 220:
            summary = summary[:217].rstrip() + "..."
        outcome_lines.append(
            "- "
            f"{task.get('id')}: status={task.get('status')} "
            f"commit={task.get('resultCommit') or '-'} "
            f"noOp={'yes' if task.get('noOp') else 'no'} "
            f"stopPending={'yes' if task.get('stopPending') else 'no'} "
            f"failure={task.get('failureReason') or '-'} "
            f"summary={summary or '-'}"
        )

    control_lines: list[str] = []
    for item in control_messages[-5:]:
        control_lines.append(
            f"- request={item.get('requestId') or '-'} type={item.get('type') or '-'} payload={json.dumps(item.get('payload') or {}, ensure_ascii=True)}"
        )

    commands = (
        f"Skill command path: {run_sh}\n"
        "Use only these commands for workflow control in this turn:\n"
        f"- {run_sh} validate --workflow {workflow_path}\n"
        f"- {run_sh} ready-tasks --workflow {workflow_path} --json\n"
        f"- {run_sh} launch-task --workflow {workflow_path} --task-id <task-id>\n"
        f"- {run_sh} reconcile --workflow {workflow_path}\n"
        f"- {run_sh} show --workflow {workflow_path}\n"
        f"- {run_sh} status --workflow {workflow_path}\n"
    )

    built_in = str(scheduler_state.get("builtInPrompt") or "").strip() or DEFAULT_SCHEDULER_PROMPT

    dynamic = (
        f"Trigger reason: {reason}\n"
        f"Workflow file: {workflow_path}\n"
        f"Workflow: {workflow.get('id')} ({workflow.get('status')})\n"
        f"Target branch: {workflow.get('targetBranch')}\n"
        f"User request: {workflow.get('request')}\n"
        f"Max parallel: {settings.get('maxParallel')}\n"
        f"Scheduler session: {scheduler_state.get('lastSessionId') or '-'}\n"
        f"Scheduler thread: {scheduler_state.get('threadId') or '-'} turn={scheduler_state.get('lastTurnId') or '-'} status={scheduler_state.get('lastTurnStatus') or '-'}\n"
        f"Running tasks now: {', '.join(running_tasks) if running_tasks else '-'}\n"
        f"Ready tasks now: {', '.join(ready_ids) if ready_ids else '-'}\n"
        "Current tasks:\n"
        + ("\n".join(task_lines) if task_lines else "- (none)")
        + "\nRecent task outcomes:\n"
        + ("\n".join(outcome_lines) if outcome_lines else "- (none)")
        + "\nPending control messages:\n"
        + ("\n".join(control_lines) if control_lines else "- (none)")
    )

    return f"{built_in}\n\n{commands}\n{dynamic}"


def _run_codex_command(
    cmd: list[str],
    project_root: pathlib.Path,
    env: dict[str, str] | None = None,
    *,
    workflow_path: pathlib.Path | None = None,
) -> tuple[int, str]:
    proc = subprocess.Popen(
        cmd,
        cwd=str(project_root),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        start_new_session=True,
    )
    if workflow_path is not None:
        try:
            set_scheduler_active_command(workflow_path, pid=proc.pid, command=cmd)
        except Exception:
            # Scheduler process tracking is best-effort.
            pass
    try:
        stdout, stderr = proc.communicate()
    finally:
        if workflow_path is not None:
            try:
                set_scheduler_active_command(workflow_path, pid=None)
            except Exception:
                # Scheduler process tracking is best-effort.
                pass
    output = (stdout or "") + ("\n" + stderr if stderr else "")
    return proc.returncode, output



def fallback_latest_session_id(codex_home_value: str, started_at: str | None, project_root: pathlib.Path | None = None) -> str:
    home = pathlib.Path(codex_home_value).expanduser().resolve()
    sessions_dir = home / "sessions"
    if not sessions_dir.is_dir():
        return ""
    started_dt = parse_iso(started_at)
    min_epoch: float | None = None
    max_epoch: float | None = None
    if started_dt is not None:
        min_epoch = started_dt.timestamp() - 10.0
        max_epoch = started_dt.timestamp() + 300.0
    normalized_project_root = os.path.realpath(project_root) if project_root else ""
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
        if normalized_project_root:
            try:
                first = path.read_text(encoding="utf-8", errors="replace").splitlines()[0]
                if normalized_project_root not in first:
                    continue
            except Exception:
                continue
        session_id = extract_session_id_from_file(path)
        if session_id:
            candidates.append(session_id)
            if len(candidates) > 1:
                return ""
    return candidates[0] if len(candidates) == 1 else ""



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


def resolve_session_file(session_id: str, codex_home_path: str) -> pathlib.Path:
    """Locate one Codex session JSONL file by filename or payload id."""

    normalized_session_id = str(session_id or "").strip()
    if not SESSION_ID_EXACT_REGEX.fullmatch(normalized_session_id):
        raise FileNotFoundError(f"invalid session id: {normalized_session_id or '<empty>'}")

    sessions_dir = pathlib.Path(codex_home_path).expanduser().resolve() / "sessions"
    if not sessions_dir.is_dir():
        raise FileNotFoundError(f"sessions directory not found: {sessions_dir}")

    files = sorted(sessions_dir.rglob("*.jsonl"))
    for file_path in files:
        if file_path.stem == normalized_session_id or file_path.name == f"{normalized_session_id}.jsonl":
            return file_path

    for file_path in files:
        if extract_session_id_from_file(file_path) == normalized_session_id:
            return file_path

    raise FileNotFoundError(f"session file not found: {normalized_session_id}")


def collect_turn_lifecycle(lines: list[str]) -> tuple[set[str], list[str], set[str]]:
    """Track started/ended turn ids from session event records."""

    started_turn_ids: set[str] = set()
    started_turn_order: list[str] = []
    ended_turn_ids: set[str] = set()
    active_turn_id: str | None = None

    for line in lines:
        trimmed = line.strip()
        if not trimmed:
            continue
        try:
            parsed = json.loads(trimmed)
        except Exception:
            continue
        if not isinstance(parsed, dict):
            continue
        if parsed.get("type") != "event_msg":
            continue
        payload = parsed.get("payload")
        if not isinstance(payload, dict):
            continue
        event_type = str(payload.get("type") or "").strip()
        turn_id = str(payload.get("turn_id") or "").strip()
        if not turn_id:
            continue

        if event_type == "task_started":
            if active_turn_id and active_turn_id != turn_id:
                ended_turn_ids.add(active_turn_id)
            if turn_id not in started_turn_ids:
                started_turn_ids.add(turn_id)
                started_turn_order.append(turn_id)
            active_turn_id = turn_id
            continue

        if event_type in {"task_complete", "turn_aborted"}:
            ended_turn_ids.add(turn_id)
            if active_turn_id == turn_id:
                active_turn_id = None

    return started_turn_ids, started_turn_order, ended_turn_ids


def fix_dangling_turns(session_id: str, codex_home_path: str) -> dict[str, Any]:
    """Append synthetic completions for dangling turns in one session log.

    This mutates the session file and should only be called from explicit
    operator actions, such as the Workflow UI "Fix dangling" / "Stop All".
    """

    normalized_session_id = str(session_id or "").strip()
    file_path = resolve_session_file(normalized_session_id, codex_home_path)
    content = file_path.read_text(encoding="utf-8", errors="replace")
    lines = content.split("\n")
    started_turn_ids, started_turn_order, ended_turn_ids = collect_turn_lifecycle(lines)
    dangling_turn_ids = [turn_id for turn_id in started_turn_order if turn_id not in ended_turn_ids]

    if dangling_turn_ids:
        now = dt.datetime.now(dt.timezone.utc)
        synthetic_lines: list[str] = []
        for index, turn_id in enumerate(dangling_turn_ids):
            timestamp = (now + dt.timedelta(milliseconds=index)).isoformat(timespec="milliseconds").replace(
                "+00:00", "Z"
            )
            synthetic_lines.append(
                json.dumps(
                    {
                        "timestamp": timestamp,
                        "type": "event_msg",
                        "payload": {
                            "type": "task_complete",
                            "turn_id": turn_id,
                            "last_agent_message": "[codex-deck] Synthetic completion generated by Fix dangling.",
                        },
                    },
                    ensure_ascii=True,
                )
            )

        append_text = "\n".join(synthetic_lines)
        if append_text:
            if content and not content.endswith("\n"):
                append_text = f"\n{append_text}"
            append_text = f"{append_text}\n"
            with file_path.open("a", encoding="utf-8") as handle:
                handle.write(append_text)

    return {
        "sessionId": normalized_session_id,
        "filePath": str(file_path),
        "startedTurnCount": len(started_turn_ids),
        "endedTurnCountBefore": len(ended_turn_ids),
        "endedTurnCountAfter": len(ended_turn_ids) + len(dangling_turn_ids),
        "danglingTurnIds": dangling_turn_ids,
        "appendedTurnIds": dangling_turn_ids,
    }


def run_scheduler_turn(data: dict[str, Any], workflow_path: pathlib.Path, reason: str) -> tuple[int, str, bool, str, str | None, str | None]:
    """Execute one scheduler turn and capture continuity metadata."""

    project_root = pathlib.Path(str(data["workflow"]["projectRoot"]))
    settings = data.get("settings", {}) if isinstance(data.get("settings"), dict) else {}
    command_env = codex_env(settings)
    run_sh = pathlib.Path(__file__).with_name("run.sh").resolve()
    prompt = compose_scheduler_prompt(data, reason, workflow_path, run_sh)
    scheduler_state = data.get("scheduler", {})
    session_id = str(scheduler_state.get("threadId") or scheduler_state.get("lastSessionId") or "").strip()
    started_at = now_iso()

    helper_path = pathlib.Path(__file__).with_name("codex_resume_noninteractive.py").resolve()
    # Once a thread/session already exists, prefer the non-interactive helper so
    # daemon-owned follow-up turns stay on the same app-server-backed thread.
    if session_id and helper_path.exists():
        cmd = [
            sys.executable,
            str(helper_path),
            session_id,
            prompt,
            "--cwd",
            str(project_root),
            "--json",
        ]
        used_resume = True
        append_daemon_command_history(
            workflow_path,
            source="scheduler-resume",
            command=cmd,
            cwd=project_root,
        )
        rc, raw_output = _run_codex_command(
            cmd,
            project_root,
            env=command_env,
            workflow_path=workflow_path,
        )
        turn_id = None
        final_status = None
        try:
            parsed = json.loads(raw_output)
            if isinstance(parsed, dict):
                turn_id = str(parsed.get("turnId") or "").strip() or None
                final_status = str(parsed.get("status") or "").strip() or None
                session_id = str(parsed.get("threadId") or parsed.get("sessionId") or session_id).strip() or session_id
            log_output = raw_output
        except Exception:
            log_output = raw_output
        if final_status is None:
            final_status = "completed" if rc == 0 else "failed"
    else:
        cmd = codex_command(settings, "exec", prompt)
        used_resume = False
        append_daemon_command_history(
            workflow_path,
            source="scheduler-start",
            command=cmd,
            cwd=project_root,
        )
        rc, log_output = _run_codex_command(
            cmd,
            project_root,
            env=command_env,
            workflow_path=workflow_path,
        )
        session_id = extract_session_id(log_output)
        if not session_id:
            codex_home_value = str(settings.get("codexHome") or "").strip()
            if codex_home_value:
                session_id = fallback_latest_session_id(codex_home_value, started_at, project_root)
        turn_id = None
        final_status = "completed" if rc == 0 else "failed"

    log_dir = workflow_path.parent / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    with (log_dir / "scheduler.log").open("a", encoding="utf-8") as handle:
        handle.write(
            f"\n===== {now_iso()} reason={reason} helper_resume={used_resume} session_id={session_id or '-'} turn_id={turn_id or '-'} status={final_status or '-'} rc={rc} =====\n"
        )
        handle.write(log_output)
        if not log_output.endswith("\n"):
            handle.write("\n")

    return rc, log_output, used_resume, session_id, turn_id, final_status


def finalize_trigger_success(wf_path: pathlib.Path, lock_path: pathlib.Path, reason: str) -> tuple[bool, bool]:
    """Finalize a successful scheduler turn and decide whether to rerun once."""

    with with_lock(lock_path):
        data = load_json(wf_path)
        errors = validate_workflow_data(data)
        if errors:
            data["workflow"]["status"] = "failed"
            data["scheduler"]["running"] = False
            data["scheduler"]["pendingTrigger"] = False
            update_scheduler_controller(data, activeRequestId=None)
            append_history(data, "scheduler_trigger_validation_failed", {"errors": errors})
            write_json(wf_path, data)
            return (False, False)

        # pendingTrigger is deliberately coalesced to a single rerun. If many
        # events arrived while the scheduler was busy, we still only schedule
        # one immediate follow-up pass because that pass will re-read full state.
        rerun = bool(data["scheduler"].get("pendingTrigger"))
        data["scheduler"]["running"] = False
        data["scheduler"]["pendingTrigger"] = False
        update_scheduler_controller(data, activeRequestId=None)
        append_history(data, "scheduler_trigger_finished", {"rerun": rerun})

        status = compute_workflow_status(data)
        if status:
            data["workflow"]["status"] = status
        write_json(wf_path, data)

        if rerun:
            data["scheduler"]["running"] = True
            data["scheduler"]["lastRunAt"] = now_iso()
            data["scheduler"]["lastReason"] = reason
            append_history(data, "scheduler_trigger_restarted", {})
            write_json(wf_path, data)
            return (True, True)
        return (False, True)


def cmd_trigger(args: argparse.Namespace) -> int:
    """Run the scheduler trigger path in direct mode or daemon mode.

    This function is careful to avoid overlapping scheduler turns. If another
    turn is already active, it records a single pending rerun instead of trying
    to run concurrently.
    """

    wf_path = pathlib.Path(args.workflow).expanduser().resolve()
    lock_path = wf_path.with_suffix(".lock")
    request_id = str(getattr(args, "request_id", "") or "").strip() or None
    controller_mode = str(getattr(args, "controller_mode", "") or "direct").strip() or "direct"
    controller_pid = getattr(args, "controller_pid", None)

    reason = args.reason
    while True:
        with with_lock(lock_path):
            data = load_json(wf_path)
            refresh_workflow_state(data, reason=f"trigger:{reason}")
            scheduler_state = data["scheduler"]
            scheduler_state["controllerMode"] = controller_mode
            update_scheduler_controller(
                data,
                daemonPid=controller_pid,
                lastHeartbeatAt=now_iso() if controller_mode == "daemon" else None,
            )
            if scheduler_state.get("running"):
                last_run = parse_iso(scheduler_state.get("lastRunAt"))
                stale = True
                # A non-stale running turn keeps ownership; we only remember that
                # another pass is needed. If the run looks abandoned, recover by
                # clearing the flag and starting a fresh turn from current state.
                if last_run is not None:
                    age = (dt.datetime.now(dt.timezone.utc) - last_run).total_seconds()
                    stale = age > SCHEDULER_STALE_SECONDS
                if not stale:
                    scheduler_state["pendingTrigger"] = True
                    scheduler_state["lastReason"] = reason
                    update_scheduler_controller(data, activeRequestId=request_id)
                    append_history(data, "scheduler_trigger_pending", {"reason": reason, "requestId": request_id})
                    write_json(wf_path, data)
                    print("pending")
                    return 0
                scheduler_state["running"] = False
                append_history(data, "scheduler_trigger_stale_recovered", {"reason": reason, "requestId": request_id})

            scheduler_state["running"] = True
            scheduler_state["lastReason"] = reason
            scheduler_state["lastRunAt"] = now_iso()
            controller = scheduler_state.setdefault("controller", {})
            if isinstance(controller, dict):
                controller["stopRequestedAt"] = None
                controller["stopRequestId"] = None
            update_scheduler_controller(
                data,
                activeRequestId=request_id,
                lastDequeuedAt=now_iso() if request_id else data.get("scheduler", {}).get("controller", {}).get("lastDequeuedAt"),
            )
            append_history(data, "scheduler_trigger_started", {"reason": reason, "requestId": request_id})
            write_json(wf_path, data)

        data = load_json(wf_path)
        rc, output, used_resume, session_id, turn_id, turn_status = run_scheduler_turn(data, wf_path, reason)

        with with_lock(lock_path):
            data = load_json(wf_path)
            if session_id:
                data["scheduler"]["lastSessionId"] = session_id
                data["scheduler"]["threadId"] = session_id
            data["scheduler"]["lastTurnId"] = turn_id
            data["scheduler"]["lastTurnStatus"] = turn_status
            data["scheduler"]["lastComposedPrompt"] = compose_scheduler_prompt(
                data,
                reason,
                wf_path,
                pathlib.Path(__file__).with_name("run.sh").resolve(),
            )
            write_json(wf_path, data)

            if rc != 0:
                controller = data.get("scheduler", {}).get("controller")
                stop_requested_at = (
                    str(controller.get("stopRequestedAt") or "").strip()
                    if isinstance(controller, dict)
                    else ""
                )
                stop_request_id = (
                    str(controller.get("stopRequestId") or "").strip()
                    if isinstance(controller, dict)
                    else ""
                )

                if stop_requested_at:
                    refresh_workflow_state(data, reason=f"trigger-stopped:{reason}")
                    data["scheduler"]["lastTurnStatus"] = "stopped"
                else:
                    refresh_workflow_state(data, reason=f"trigger-failed:{reason}")
                    computed_status = compute_workflow_status(data)
                    if computed_status:
                        data["workflow"]["status"] = computed_status
                    else:
                        data["workflow"]["status"] = "failed"
                data["scheduler"]["running"] = False
                data["scheduler"]["pendingTrigger"] = False
                update_scheduler_controller(data, activeRequestId=None)
                if stop_requested_at:
                    append_history(
                        data,
                        "scheduler_trigger_stopped",
                        {
                            "reason": reason,
                            "exitCode": rc,
                            "usedResume": used_resume,
                            "requestId": request_id,
                            "stopRequestId": stop_request_id or None,
                            "stoppedAt": stop_requested_at,
                        },
                    )
                    if isinstance(controller, dict):
                        controller["stopRequestedAt"] = None
                        controller["stopRequestId"] = None
                else:
                    append_history(
                        data,
                        "scheduler_trigger_failed",
                        {
                            "reason": reason,
                            "exitCode": rc,
                            "usedResume": used_resume,
                            "requestId": request_id,
                        },
                    )
                write_json(wf_path, data)
                if stop_requested_at:
                    print("stopped")
                    return 0
                print("error: scheduler turn failed", file=sys.stderr)
                if output.strip():
                    print(output.strip().splitlines()[-1], file=sys.stderr)
                return 1

        should_rerun, success = finalize_trigger_success(wf_path, lock_path, reason)
        if not success:
            print("error: scheduler post-turn validation failed", file=sys.stderr)
            return 1
        if not should_rerun:
            print("ok")
            return 0
        reason = "pending-trigger"


def cmd_set_session(args: argparse.Namespace) -> int:
    wf_path = pathlib.Path(args.workflow).expanduser().resolve()
    lock_path = wf_path.with_suffix(".lock")
    with with_lock(lock_path):
        data = load_json(wf_path)
        task = get_task(data, args.task_id)
        if not task:
            print("error: task not found", file=sys.stderr)
            return 1
        task["sessionId"] = args.session_id
        append_history(data, "task_session_attached", {"taskId": args.task_id, "sessionId": args.session_id})
        write_json(wf_path, data)
    return 0


def apply_task_finish(
    data: dict[str, Any],
    task_id: str,
    *,
    success: bool,
    summary: str = "",
    result_commit: str = "",
    failure_reason: str = "",
    no_op: bool = False,
    stop_pending: bool = False,
) -> None:
    """Apply a worker result payload to the persisted task record."""

    task = get_task(data, task_id)
    if not task:
        raise KeyError(task_id)
    task["finishedAt"] = now_iso()
    task["resultCommit"] = result_commit or task.get("resultCommit")
    task["summary"] = summary
    task["runnerPid"] = None
    task["noOp"] = bool(no_op)
    task["stopPending"] = bool(stop_pending)
    if success:
        task["status"] = "success"
        task["failureReason"] = None
    else:
        # A failed task still keeps any summary/result metadata we managed to
        # collect so later inspection can explain what happened.
        task["status"] = "failed"
        task["failureReason"] = failure_reason or "Task failed"
    append_history(
        data,
        "task_finished",
        {"taskId": task_id, "success": success, "noOp": bool(no_op), "stopPending": bool(stop_pending)},
    )

    status = compute_workflow_status(data)
    if status:
        data["workflow"]["status"] = status


def cmd_finish(args: argparse.Namespace) -> int:
    wf_path = pathlib.Path(args.workflow).expanduser().resolve()
    lock_path = wf_path.with_suffix(".lock")
    with with_lock(lock_path):
        data = load_json(wf_path)
        try:
            apply_task_finish(
                data,
                args.task_id,
                success=bool(args.success),
                summary=args.summary,
                result_commit=args.result_commit,
                failure_reason=args.failure_reason,
                no_op=bool(args.no_op),
                stop_pending=bool(args.stop_pending),
            )
        except KeyError:
            print("error: task not found", file=sys.stderr)
            return 1
        write_json(wf_path, data)
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    wf_path = pathlib.Path(args.workflow).expanduser().resolve()
    data = load_json(wf_path)
    print(json.dumps(data, ensure_ascii=True, indent=2))
    return 0


def cmd_render_main_prompt(args: argparse.Namespace) -> int:
    wf_path = pathlib.Path(args.workflow).expanduser().resolve()
    data = load_json(wf_path)
    run_sh = pathlib.Path(__file__).with_name("run.sh").resolve()
    print(compose_scheduler_prompt(data, args.reason, wf_path, run_sh))
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    wf_path = pathlib.Path(args.workflow).expanduser().resolve()
    data = load_json(wf_path)
    print(f"workflow: {data['workflow']['id']} status={data['workflow']['status']}")
    print(
        f"scheduler: running={data['scheduler']['running']} pending={data['scheduler']['pendingTrigger']} session={data['scheduler'].get('lastSessionId') or '-'}"
    )
    for task in data.get("tasks", []):
        print(
            f"- {task.get('id')}: status={task.get('status')} deps={','.join(task.get('dependsOn', [])) or '-'} session={task.get('sessionId') or '-'}"
        )
    return 0


def cmd_resolve_workflow(args: argparse.Namespace) -> int:
    project_root = pathlib.Path(args.project_root).expanduser().resolve()
    workflow_id = sanitize_id(args.workflow_id)
    workflow_path, source = resolve_workflow_path(project_root, workflow_id, args.codex_home or None)
    exists = workflow_path.is_file()
    registry_path = workflow_registry_file(project_root, workflow_id, args.codex_home or None)
    payload = {
        "workflowId": workflow_id,
        "workflowPath": str(workflow_path),
        "projectRoot": str(project_root),
        "source": source,
        "exists": exists,
        "registryPath": str(registry_path),
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=True))
    elif exists:
        print(workflow_path)
    else:
        print(
            f"error: workflow not found for project root {project_root} and workflow id {workflow_id}",
            file=sys.stderr,
        )
        print(f"canonical path: {workflow_path}", file=sys.stderr)
        print(f"registry path: {registry_path}", file=sys.stderr)
    return 0 if exists else 1


def cmd_merge(args: argparse.Namespace) -> int:
    """Preview, create, or apply the explicit integration-branch merge for successful tasks."""

    wf_path = pathlib.Path(args.workflow).expanduser().resolve()
    data = load_json(wf_path)
    root = pathlib.Path(data["workflow"]["projectRoot"])
    target = data["workflow"]["targetBranch"]
    integration_branch = args.integration_branch or f"flow/{data['workflow']['id']}/integration"

    successful_branches: list[tuple[str, list[dict[str, Any]]]] = []
    by_branch: dict[str, list[dict[str, Any]]] = {}
    for task in data.get("tasks", []):
        if not isinstance(task, dict):
            continue
        if task.get("status") != "success":
            continue
        branch_name = str(task.get("branchName") or "").strip()
        if not branch_name:
            continue
        bucket = by_branch.setdefault(branch_name, [])
        if not bucket:
            successful_branches.append((branch_name, bucket))
        bucket.append(task)
    if not successful_branches:
        print("error: no successful branches to merge", file=sys.stderr)
        return 1

    if args.preview:
        base = subprocess.check_output(["git", "-C", str(root), "rev-parse", target], text=True).strip()
        print(f"preview target: {target}")
        print(f"preview base: {base}")
        print(f"preview integration branch: {integration_branch}")
        print("preview successful task branches:")
        for branch_name, branch_tasks in successful_branches:
            head = subprocess.check_output(["git", "-C", str(root), "rev-parse", branch_name], text=True).strip()
            commits = subprocess.check_output(
                ["git", "-C", str(root), "log", "--oneline", f"{target}..{branch_name}"],
                text=True,
            ).strip()
            task_ids = ", ".join(str(task.get("id") or "-") for task in branch_tasks)
            print(f"- {branch_name} @ {head} (tasks: {task_ids})")
            if commits:
                for line in commits.splitlines():
                    print(f"    {line}")
            else:
                print("    (no commits ahead of target)")
        return 0

    subprocess.check_call(["git", "-C", str(root), "checkout", target])
    base = subprocess.check_output(["git", "-C", str(root), "rev-parse", target], text=True).strip()
    subprocess.check_call(["git", "-C", str(root), "checkout", "-B", integration_branch, base])

    for branch_name, _branch_tasks in successful_branches:
        subprocess.check_call(["git", "-C", str(root), "merge", "--no-ff", "--no-edit", branch_name])

    if args.apply:
        subprocess.check_call(["git", "-C", str(root), "checkout", target])
        subprocess.check_call(["git", "-C", str(root), "merge", "--no-ff", "--no-edit", integration_branch])
        print(f"merged integration branch {integration_branch} into {target}")
    else:
        print(f"integration branch ready: {integration_branch}")
    return 0


def backfill_project_workflow_registry(project_root: pathlib.Path, codex_home_path: str | None = None) -> int:
    flow_dir = project_root / ".codex-deck"
    if not flow_dir.exists() or not flow_dir.is_dir():
        return 0

    count = 0
    for candidate in sorted(flow_dir.glob("*.json")):
        if candidate.name.endswith(".tasks.json"):
            continue
        try:
            payload = load_json(candidate)
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue
        workflow = payload.get("workflow")
        tasks = payload.get("tasks")
        if not isinstance(workflow, dict) or not isinstance(tasks, list):
            continue
        if codex_home_path:
            payload.setdefault("settings", {})
            if isinstance(payload.get("settings"), dict):
                payload["settings"]["codexHome"] = codex_home(codex_home_path)
        try:
            sync_workflow_registry(candidate, payload)
        except Exception:
            continue
        count += 1
    return count


def cmd_create(args: argparse.Namespace) -> int:
    """Author a new workflow JSON file from operator input."""

    project_root = pathlib.Path(args.project_root).expanduser().resolve()
    wf_id = sanitize_id(args.workflow_id or args.title)
    wf_path = workflow_file(project_root, wf_id)
    lock_path = wf_path.with_suffix(".lock")
    with with_lock(lock_path):
        if wf_path.exists() and not args.force:
            print_create_conflict(build_create_conflict_payload(project_root, wf_id), json_output=args.json)
            return 1

        tasks: list[dict[str, Any]] = []
        if args.tasks_json:
            tasks_input = json.loads(pathlib.Path(args.tasks_json).read_text(encoding="utf-8"))
            if not isinstance(tasks_input, list):
                print("error: tasks json must be an array", file=sys.stderr)
                return 1
            for idx, item in enumerate(tasks_input):
                if not isinstance(item, dict):
                    continue
                task_id = sanitize_id(str(item.get("id") or f"task-{idx + 1}"))
                tasks.append(
                    {
                        "id": task_id,
                        "name": str(item.get("name") or f"task-{idx + 1}"),
                        "prompt": str(item.get("prompt") or default_task_prompt(args.request, task_id)),
                        "dependsOn": [sanitize_id(str(v)) for v in item.get("dependsOn", []) if str(v).strip()],
                        "status": "pending",
                        "sessionId": None,
                        "branchName": str(item.get("branchName") or f"flow/{wf_id}/{task_id}"),
                        "worktreePath": None,
                        "baseCommit": None,
                        "resultCommit": None,
                        "startedAt": None,
                        "finishedAt": None,
                        "summary": None,
                        "failureReason": None,
                        "noOp": False,
                        "stopPending": False,
                        "runnerPid": None,
                    }
                )
        else:
            if args.task_count < 0:
                print("error: --task-count must be >= 0", file=sys.stderr)
                return 1
            for i in range(args.task_count):
                task_id = sanitize_id(f"task-{i + 1}")
                deps: list[str] = []
                if args.sequential and i > 0:
                    deps = [sanitize_id(f"task-{i}")]
                tasks.append(
                    {
                        "id": task_id,
                        "name": f"task-{i + 1}",
                        "prompt": default_task_prompt(args.request, f"task-{i + 1}"),
                        "dependsOn": deps,
                        "status": "pending",
                        "sessionId": None,
                        "branchName": f"flow/{wf_id}/{task_id}",
                        "worktreePath": None,
                        "baseCommit": None,
                        "resultCommit": None,
                        "startedAt": None,
                        "finishedAt": None,
                        "summary": None,
                        "failureReason": None,
                        "noOp": False,
                        "stopPending": False,
                        "runnerPid": None,
                    }
                )

        target_branch = args.target_branch or detect_target_branch(project_root)

        payload = {
            "workflow": {
                "id": wf_id,
                "title": args.title,
                "createdAt": now_iso(),
                "updatedAt": now_iso(),
                "status": "draft",
                "targetBranch": target_branch,
                "projectRoot": str(project_root),
                "request": args.request,
            },
            "scheduler": {
                "running": False,
                "pendingTrigger": False,
                "lastRunAt": None,
                "lastSessionId": None,
                "threadId": None,
                "lastTurnId": None,
                "lastTurnStatus": None,
                "lastReason": None,
                "controllerMode": "direct",
                "controller": {
                    "daemonPid": None,
                    "daemonStartedAt": None,
                    "lastHeartbeatAt": None,
                    "lastEnqueueAt": None,
                    "lastDequeuedAt": None,
                    "activeRequestId": None,
                },
                "builtInPrompt": DEFAULT_SCHEDULER_PROMPT,
                "lastComposedPrompt": None,
            },
            "settings": {
                "codexHome": codex_home(args.codex_home),
                "codexCliPath": codex_cli_path(args.codex_cli_path),
                "maxParallel": args.max_parallel,
                "mergePolicy": "integration-branch",
                "stopSignal": DEFAULT_STOP_SIGNAL,
            },
            "tasks": tasks,
            "history": [],
        }

        errors = validate_workflow_data(payload)
        if errors:
            print("error: initial workflow state is invalid", file=sys.stderr)
            for err in errors:
                print(f"- {err}", file=sys.stderr)
            return 1

        append_history(payload, "workflow_created", {"taskCount": len(tasks)})
        write_json(wf_path, payload)

    if args.json:
        print(
            json.dumps(
                {
                    "ok": True,
                    "workflowId": wf_id,
                    "workflowPath": str(wf_path),
                    "projectRoot": str(project_root),
                },
                ensure_ascii=True,
            )
        )
    else:
        print(wf_path)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Workflow orchestrator for the codex-deck multi-agent skill")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser(
        "create",
        help="Create a workflow draft. Defaults the target branch to the current checked-out branch.",
    )
    c.add_argument("--project-root", default=".", help="Project root used for workflow paths and branch detection.")
    c.add_argument("--workflow-id", default="")
    c.add_argument("--title", required=True)
    c.add_argument("--request", required=True)
    c.add_argument(
        "--target-branch",
        default="",
        help=(
            "Override the workflow target branch. Defaults to the current checked-out branch in "
            "--project-root and falls back to main only when branch resolution fails."
        ),
    )
    c.add_argument(
        "--task-count",
        type=int,
        default=1,
        help="Number of default tasks to generate when --tasks-json is omitted (>= 0).",
    )
    c.add_argument("--tasks-json", default="")
    c.add_argument("--sequential", action="store_true")
    c.add_argument("--max-parallel", type=int, default=1)
    c.add_argument("--codex-home", default="")
    c.add_argument("--codex-cli-path", default="")
    c.add_argument("--force", action="store_true")
    c.add_argument("--json", action="store_true")
    c.set_defaults(func=cmd_create)

    t = sub.add_parser("trigger-scheduler")
    t.add_argument("--workflow", required=True)
    t.add_argument("--reason", default="manual")
    t.set_defaults(func=cmd_trigger)

    v = sub.add_parser("validate")
    v.add_argument("--workflow", required=True)
    v.add_argument("--json", action="store_true")
    v.set_defaults(func=cmd_validate)

    rt = sub.add_parser("ready-tasks")
    rt.add_argument("--workflow", required=True)
    rt.add_argument("--json", action="store_true")
    rt.set_defaults(func=cmd_ready_tasks)

    lt = sub.add_parser("launch-task")
    lt.add_argument("--workflow", required=True)
    lt.add_argument("--task-id", required=True)
    lt.set_defaults(func=cmd_launch_task)

    r = sub.add_parser("reconcile")
    r.add_argument("--workflow", required=True)
    r.set_defaults(func=cmd_reconcile)

    s = sub.add_parser("set-task-session")
    s.add_argument("--workflow", required=True)
    s.add_argument("--task-id", required=True)
    s.add_argument("--session-id", required=True)
    s.set_defaults(func=cmd_set_session)

    f = sub.add_parser("finish-task")
    f.add_argument("--workflow", required=True)
    f.add_argument("--task-id", required=True)
    f.add_argument("--summary", default="")
    f.add_argument("--result-commit", default="")
    f.add_argument("--failure-reason", default="")
    f.add_argument("--success", action="store_true")
    f.add_argument("--no-op", action="store_true")
    f.add_argument("--stop-pending", action="store_true")
    f.set_defaults(func=cmd_finish)

    sh = sub.add_parser("show")
    sh.add_argument("--workflow", required=True)
    sh.set_defaults(func=cmd_show)

    st = sub.add_parser("status")
    st.add_argument("--workflow", required=True)
    st.set_defaults(func=cmd_status)

    rw = sub.add_parser("resolve-workflow")
    rw.add_argument("--project-root", default=".")
    rw.add_argument("--workflow-id", required=True)
    rw.add_argument("--codex-home", default="")
    rw.add_argument("--json", action="store_true")
    rw.set_defaults(func=cmd_resolve_workflow)

    rp = sub.add_parser("render-scheduler-prompt")
    rp.add_argument("--workflow", required=True)
    rp.add_argument("--reason", default="manual")
    rp.set_defaults(func=cmd_render_main_prompt)

    m = sub.add_parser("merge")
    m.add_argument("--workflow", required=True)
    m.add_argument("--integration-branch", default="")
    m.add_argument("--preview", action="store_true")
    m.add_argument("--apply", action="store_true")
    m.set_defaults(func=cmd_merge)

    b = sub.add_parser("backfill-registry")
    b.add_argument("--project-root", default=".")
    b.add_argument("--codex-home", default="")
    b.set_defaults(
        func=lambda args: (
            print(
                backfill_project_workflow_registry(
                    pathlib.Path(args.project_root).expanduser().resolve(),
                    args.codex_home or None,
                )
            )
            or 0
        )
    )

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
