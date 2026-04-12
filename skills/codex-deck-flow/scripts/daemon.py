#!/usr/bin/env python3
"""Background daemon that owns codex-deck-flow orchestration after handoff.

The skill itself is intentionally short-lived: it validates or creates a
workflow, sends one control message, and exits. This module is the long-running
runtime that receives those control messages, mutates workflow state under a
lock, and schedules the next scheduler pass when task results arrive.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

from daemon_client import (
    daemon_lock_path,
    daemon_state_path,
    default_state_payload,
    ensure_daemon_dir,
    find_free_port,
    legacy_daemon_state_path,
    process_is_alive,
    random_token,
    read_legacy_state,
    read_state,
    write_state,
)
import workflow as workflow_mod


POLL_INTERVAL_SECONDS = 1.0
HEARTBEAT_INTERVAL_SECONDS = 5.0
CONTROL_QUEUE_KEY = "__daemon_control__"
SESSION_ID_LABEL_REGEX = re.compile(
    r"session[_ ]id:\s*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})",
    re.IGNORECASE,
)
SESSION_ID_ANY_REGEX = re.compile(
    r"\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b"
)


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class WorkflowDaemon:
    """In-process daemon state for one user-global codex-deck-flow daemon."""

    def __init__(self, port: int, token: str, log_path: pathlib.Path, daemon_id: str):
        self.port = port
        self.token = token
        self.log_path = log_path
        self.daemon_id = daemon_id
        self.shutdown_event = threading.Event()
        self.server: ThreadingHTTPServer | None = None
        self.state_lock = threading.Lock()
        self.queue_lock = threading.Lock()
        self.workflow_queues: dict[str, deque[dict[str, Any]]] = {}
        self.queue_events: dict[str, threading.Event] = {}
        self.worker_threads: dict[str, threading.Thread] = {}
        self.active_workflows: set[str] = set()
        self.active_projects: set[str] = set()

    def log(self, message: str) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(f"[{now_iso()}] {message}\n")

    def queue_depth(self) -> int:
        with self.queue_lock:
            return sum(len(queue) for queue in self.workflow_queues.values())

    def update_state(self, **fields: Any) -> None:
        """Persist daemon heartbeat and lightweight runtime metadata."""

        with self.state_lock:
            payload = read_state()
            payload.update(fields)
            payload["schemaVersion"] = payload.get("schemaVersion") or default_state_payload()["schemaVersion"]
            payload["scope"] = "global"
            payload["daemonId"] = self.daemon_id
            payload["lastHeartbeatAt"] = now_iso()
            payload["queueDepth"] = self.queue_depth()
            payload["activeProjects"] = sorted(self.active_projects)
            payload["activeWorkflows"] = sorted(self.active_workflows)
            write_state(None, payload)

    def _validate_workflow_scope(self, project_root: pathlib.Path, workflow_path: pathlib.Path) -> None:
        if not project_root.is_absolute():
            raise ValueError("projectRoot must be an absolute path")
        if not workflow_path.is_absolute():
            raise ValueError("workflow must be an absolute path")
        allowed_root = (project_root / ".codex-deck").resolve()
        resolved_workflow = workflow_path.resolve()
        try:
            resolved_workflow.relative_to(allowed_root)
        except ValueError as exc:
            raise ValueError("workflow must resolve under <projectRoot>/.codex-deck/") from exc

    def _normalize_message(self, message: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(message)
        message_type = str(normalized.get("type") or "enqueue-trigger").strip() or "enqueue-trigger"
        reason = str(normalized.get("reason") or "daemon").strip() or "daemon"
        request_id = str(normalized.get("requestId") or workflow_mod.sanitize_id(f"req-{time.time_ns()}"))
        project_root_text = str(normalized.get("projectRoot") or "").strip()
        workflow_text = str(normalized.get("workflow") or "").strip()

        project_root: pathlib.Path | None = None
        workflow_path: pathlib.Path | None = None

        if workflow_text:
            raw_workflow = pathlib.Path(workflow_text).expanduser()
            if not raw_workflow.is_absolute():
                raise ValueError("workflow must be an absolute path")
            workflow_path = raw_workflow.resolve()
        if project_root_text:
            raw_project_root = pathlib.Path(project_root_text).expanduser()
            if not raw_project_root.is_absolute():
                raise ValueError("projectRoot must be an absolute path")
            project_root = raw_project_root.resolve()
        elif workflow_path is not None:
            project_root = workflow_path.parent.parent.resolve()

        if message_type in {
            "enqueue-trigger",
            "task-finished",
            "task-failed",
            "workflow-mutate",
            "stop-workflow-processes",
        }:
            if workflow_path is None:
                raise ValueError(f"{message_type} requires workflow path")
            if project_root is None:
                raise ValueError(f"{message_type} requires projectRoot")
            self._validate_workflow_scope(project_root, workflow_path)

        normalized["type"] = message_type
        normalized["reason"] = reason
        normalized["requestId"] = request_id
        normalized["receivedAt"] = now_iso()
        normalized["projectRoot"] = str(project_root) if project_root is not None else ""
        normalized["workflow"] = str(workflow_path) if workflow_path is not None else ""
        return normalized

    def _queue_key(self, message: dict[str, Any]) -> str:
        workflow_path = str(message.get("workflow") or "").strip()
        return workflow_path or CONTROL_QUEUE_KEY

    def _ensure_worker_locked(self, key: str) -> threading.Event:
        queue = self.workflow_queues.get(key)
        if queue is None:
            queue = deque()
            self.workflow_queues[key] = queue
        event = self.queue_events.get(key)
        if event is None:
            event = threading.Event()
            self.queue_events[key] = event
        thread = self.worker_threads.get(key)
        if thread is None or not thread.is_alive():
            thread = threading.Thread(target=self._worker_loop, args=(key,), daemon=True, name=f"codex-deck-{key}")
            self.worker_threads[key] = thread
            thread.start()
        return event

    def enqueue(self, message: dict[str, Any]) -> dict[str, Any]:
        """Normalize and queue one control message for a workflow-local worker."""

        normalized = self._normalize_message(message)
        project_root = str(normalized.get("projectRoot") or "").strip()
        workflow_path = str(normalized.get("workflow") or "").strip()
        message_type = str(normalized.get("type") or "")
        request_id = str(normalized.get("requestId") or "")

        if project_root:
            self.active_projects.add(project_root)
        if workflow_path:
            self.active_workflows.add(workflow_path)

        if message_type == "stop-workflow-processes":
            self.log(
                f"handling immediate stop-workflow-processes project={project_root or '-'} workflow={workflow_path or '-'} request={request_id}"
            )
            result = self._stop_workflow_processes(
                project_root,
                workflow_path,
                request_id=request_id,
                reason=str(normalized.get("reason") or "manual"),
            )
            self.update_state(lastRequestAt=now_iso(), state="running")
            return {
                "accepted": True,
                "requestId": request_id,
                "queueDepth": self.queue_depth(),
                "daemonId": self.daemon_id,
                **result,
            }

        if workflow_path:
            self._mark_workflow_enqueued(project_root, workflow_path, request_id)

        with self.queue_lock:
            key = self._queue_key(normalized)
            event = self._ensure_worker_locked(key)
            self.workflow_queues[key].append(normalized)
        event.set()
        self.update_state(lastRequestAt=now_iso(), state="running")
        self.log(
            f"enqueued type={message_type} project={project_root or '-'} workflow={workflow_path or '-'} request={request_id}"
        )
        return {"accepted": True, "requestId": request_id, "queueDepth": self.queue_depth(), "daemonId": self.daemon_id}

    def _parse_pid(self, value: Any) -> int | None:
        if isinstance(value, int):
            return value if value > 0 else None
        if isinstance(value, str):
            text = value.strip()
            if text.isdigit():
                parsed = int(text)
                return parsed if parsed > 0 else None
        return None

    def _parse_session_id(self, value: Any) -> str | None:
        text = str(value or "").strip()
        if not text:
            return None
        if workflow_mod.SESSION_ID_EXACT_REGEX.fullmatch(text):
            return text
        labeled = SESSION_ID_LABEL_REGEX.search(text)
        if labeled:
            return labeled.group(1)
        embedded = SESSION_ID_ANY_REGEX.search(text)
        if embedded:
            return embedded.group(1)
        return None

    def _task_log_session_id(self, workflow_path: pathlib.Path, task_id: str) -> str | None:
        normalized_task_id = str(task_id or "").strip()
        if not normalized_task_id:
            return None
        log_path = workflow_path.parent / "logs" / f"{normalized_task_id}.log"
        try:
            if not log_path.is_file():
                return None
            text = log_path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return None
        labeled = SESSION_ID_LABEL_REGEX.search(text)
        if labeled:
            return labeled.group(1)
        extracted = workflow_mod.extract_session_id(text)
        return self._parse_session_id(extracted)

    def _infer_recent_scheduler_session_id(
        self,
        *,
        codex_home_value: str,
        started_at: str,
        project_root: str,
    ) -> str | None:
        """Best-effort scheduler session inference when state has no id yet.

        This primarily covers the first scheduler `codex exec` turn, where
        Stop All can kill the process before `scheduler.lastSessionId` has been
        persisted.
        """

        started_dt = workflow_mod.parse_iso(started_at)
        if started_dt is None:
            return None
        sessions_dir = pathlib.Path(codex_home_value).expanduser().resolve() / "sessions"
        if not sessions_dir.is_dir():
            return None

        normalized_project_root = os.path.realpath(pathlib.Path(project_root).expanduser().resolve())
        min_epoch = started_dt.timestamp() - 5.0
        max_epoch = time.time() + 5.0
        candidates: list[tuple[float, str]] = []

        files = sorted(sessions_dir.rglob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        for path in files[:200]:
            try:
                mtime = path.stat().st_mtime
            except OSError:
                continue
            if mtime < min_epoch or mtime > max_epoch:
                continue
            try:
                first_line = path.read_text(encoding="utf-8", errors="replace").splitlines()[0]
                parsed = json.loads(first_line)
            except Exception:
                continue
            if not isinstance(parsed, dict):
                continue
            payload = parsed.get("payload")
            if not isinstance(payload, dict):
                continue
            cwd = os.path.realpath(str(payload.get("cwd") or "").strip()) if str(payload.get("cwd") or "").strip() else ""
            if cwd != normalized_project_root:
                continue
            session_id = self._parse_session_id(payload.get("id"))
            if session_id is None:
                session_id = self._parse_session_id(workflow_mod.extract_session_id_from_file(path))
            if session_id is None:
                continue
            candidates.append((mtime, session_id))

        if not candidates:
            return None
        candidates.sort(key=lambda item: item[0], reverse=True)
        return candidates[0][1]

    def _terminate_process_group(self, pid: int) -> bool:
        if pid <= 0:
            return False
        try:
            pgid = os.getpgid(pid)
        except OSError:
            return False
        terminated = False
        try:
            os.killpg(pgid, signal.SIGTERM)
            terminated = True
        except OSError:
            return False

        deadline = time.time() + 2.0
        while time.time() < deadline and process_is_alive(pid):
            time.sleep(0.05)

        if process_is_alive(pid):
            try:
                os.killpg(pgid, signal.SIGKILL)
                terminated = True
            except OSError:
                return terminated
        return terminated

    def _stop_workflow_processes(
        self,
        project_root: str,
        workflow_path: str,
        *,
        request_id: str,
        reason: str,
    ) -> dict[str, Any]:
        wf_path = pathlib.Path(workflow_path).expanduser().resolve()
        lock_path = wf_path.with_suffix(".lock")
        stopped_pids: set[int] = set()
        stopped_task_ids: list[str] = []
        stopped_session_ids: set[str] = set()
        stopped_scheduler_pid: int | None = None

        with workflow_mod.with_lock(lock_path):
            data = workflow_mod.load_json(wf_path)
            settings = data.get("settings")
            if not isinstance(settings, dict):
                settings = {}
            codex_home_value = workflow_mod.codex_home(str(settings.get("codexHome") or ""))
            tasks = data.get("tasks", [])
            if not isinstance(tasks, list):
                tasks = []

            for task in tasks:
                if not isinstance(task, dict):
                    continue
                if str(task.get("status") or "") != "running":
                    continue
                task_id = str(task.get("id") or "").strip()
                pid = self._parse_pid(task.get("runnerPid"))
                if pid is None:
                    continue
                task_session_id = self._parse_session_id(task.get("sessionId"))
                if task_session_id is None:
                    task_session_id = self._task_log_session_id(wf_path, task_id)
                if self._terminate_process_group(pid):
                    stopped_pids.add(pid)
                    if task_id:
                        stopped_task_ids.append(task_id)
                    if task_session_id:
                        stopped_session_ids.add(task_session_id)
                    task["status"] = "cancelled"
                    task["finishedAt"] = task.get("finishedAt") or now_iso()
                    task["failureReason"] = "Stopped by workflow Stop All action."
                    task["runnerPid"] = None

            scheduler = data.get("scheduler")
            if isinstance(scheduler, dict):
                scheduler_state = scheduler
            else:
                scheduler_state = {}
                data["scheduler"] = scheduler_state
            controller = scheduler_state.setdefault("controller", {})
            if not isinstance(controller, dict):
                controller = {}
                scheduler_state["controller"] = controller
            scheduler_pid = self._parse_pid(controller.get("activeCommandPid"))
            if scheduler_pid is not None and self._terminate_process_group(scheduler_pid):
                stopped_pids.add(scheduler_pid)
                stopped_scheduler_pid = scheduler_pid
                scheduler_started_at = str(controller.get("activeCommandStartedAt") or "").strip()
                scheduler_session_candidates = [
                    scheduler_state.get("threadId"),
                    scheduler_state.get("lastSessionId"),
                    controller.get("activeCommandSessionId"),
                    controller.get("activeCommandSummary"),
                ]
                scheduler_state["running"] = False
                scheduler_state["pendingTrigger"] = False
                scheduler_state["lastTurnStatus"] = "stopped"
                controller["stopRequestedAt"] = now_iso()
                controller["stopRequestId"] = request_id
                controller["activeCommandPid"] = None
                controller["activeCommandStartedAt"] = None
                controller["activeCommandType"] = None
                controller["activeCommandSummary"] = None
                controller["activeCommandSessionId"] = None
                scheduler_session_found = False
                for candidate in scheduler_session_candidates:
                    parsed = self._parse_session_id(candidate)
                    if parsed:
                        stopped_session_ids.add(parsed)
                        scheduler_session_found = True
                if not scheduler_session_found:
                    project_root_for_infer = str(data.get("workflow", {}).get("projectRoot") or project_root or "").strip()
                    inferred_session_id = self._infer_recent_scheduler_session_id(
                        codex_home_value=codex_home_value,
                        started_at=scheduler_started_at,
                        project_root=project_root_for_infer or str(wf_path.parent.parent),
                    )
                    if inferred_session_id:
                        stopped_session_ids.add(inferred_session_id)
                        self.log(
                            f"inferred scheduler session workflow={workflow_path} request={request_id} session={inferred_session_id}"
                        )

            fixed_dangling_sessions: list[dict[str, Any]] = []
            fix_dangling_failures: list[dict[str, str]] = []
            for session_id in sorted(stopped_session_ids):
                try:
                    fix_result = workflow_mod.fix_dangling_turns(session_id, codex_home_value)
                    fixed_dangling_sessions.append(
                        {
                            "sessionId": session_id,
                            "appendedTurnIds": list(fix_result.get("appendedTurnIds") or []),
                        }
                    )
                except Exception as exc:
                    fix_dangling_failures.append({"sessionId": session_id, "error": str(exc)})

            workflow_mod.append_history(
                data,
                "workflow_stop_all",
                {
                    "requestId": request_id,
                    "reason": reason,
                    "projectRoot": project_root or str(wf_path.parent.parent),
                    "stoppedProcessCount": len(stopped_pids),
                    "stoppedTaskIds": sorted(set(stopped_task_ids)),
                    "stoppedSchedulerPid": stopped_scheduler_pid,
                    "stoppedSessionIds": sorted(stopped_session_ids),
                    "fixedDanglingSessions": fixed_dangling_sessions,
                    "fixDanglingFailures": fix_dangling_failures,
                },
            )
            status = workflow_mod.compute_workflow_status(data)
            if status:
                data.setdefault("workflow", {})["status"] = status
            workflow_mod.write_json(wf_path, data)

        fixed_appended_turns = sum(
            len(item.get("appendedTurnIds") or [])
            for item in fixed_dangling_sessions
            if isinstance(item, dict)
        )
        self.log(
            f"stopped workflow processes workflow={workflow_path} request={request_id} stopped={len(stopped_pids)} fixedSessions={len(fixed_dangling_sessions)} appendedTurns={fixed_appended_turns}"
        )
        return {
            "workflow": workflow_path,
            "stoppedProcesses": len(stopped_pids),
            "stoppedTaskIds": sorted(set(stopped_task_ids)),
            "stoppedSchedulerPid": stopped_scheduler_pid,
            "stoppedSessionIds": sorted(stopped_session_ids),
            "fixedDanglingSessionCount": len(fixed_dangling_sessions),
            "fixedDanglingAppendedTurnCount": fixed_appended_turns,
            "fixDanglingFailureCount": len(fix_dangling_failures),
        }

    def _mark_workflow_enqueued(self, project_root: str, workflow_path: str, request_id: str) -> None:
        wf_path = pathlib.Path(workflow_path).expanduser().resolve()
        lock_path = wf_path.with_suffix(".lock")
        try:
            state = read_state()
            started_at = str(state.get("startedAt") or "") or now_iso()
            with workflow_mod.with_lock(lock_path):
                data = workflow_mod.load_json(wf_path)
                data.setdefault("scheduler", {})["controllerMode"] = "daemon"
                workflow_mod.update_scheduler_controller(
                    data,
                    daemonId=self.daemon_id,
                    daemonScope="global",
                    daemonPid=os.getpid(),
                    daemonStartedAt=started_at,
                    lastHeartbeatAt=now_iso(),
                    lastEnqueueAt=now_iso(),
                    activeRequestId=request_id,
                    appServerStartedAt=started_at,
                )
                workflow_block = data.setdefault("workflow", {})
                existing_project_root = str(workflow_block.get("projectRoot") or "").strip()
                if not existing_project_root:
                    workflow_block["projectRoot"] = project_root or str(wf_path.parent.parent)
                workflow_mod.write_json(wf_path, data)
        except Exception as exc:
            self.log(f"failed to mark workflow enqueued {workflow_path}: {exc}")

    def _handle_message(self, message: dict[str, Any]) -> None:
        """Apply one queued control message to workflow state or scheduling."""

        message_type = str(message.get("type") or "")
        workflow_path = str(message.get("workflow") or "").strip()
        project_root = str(message.get("projectRoot") or "").strip()
        request_id = str(message.get("requestId") or "")
        reason = str(message.get("reason") or "daemon").strip() or "daemon"
        self.log(
            f"handling type={message_type} project={project_root or '-'} workflow={workflow_path or '-'} request={request_id}"
        )
        if message_type == "enqueue-trigger":
            if not workflow_path:
                raise RuntimeError("enqueue-trigger requires workflow path")
            args = argparse.Namespace(
                workflow=workflow_path,
                reason=reason,
                request_id=request_id,
                controller_mode="daemon",
                controller_pid=os.getpid(),
            )
            rc = workflow_mod.cmd_trigger(args)
            if rc != 0:
                raise RuntimeError(f"trigger-scheduler failed with exit code {rc}")
            return
        if message_type in {"task-finished", "task-failed"}:
            if not workflow_path:
                raise RuntimeError(f"{message_type} requires workflow path")
            payload = message.get("payload") or {}
            if not isinstance(payload, dict):
                raise RuntimeError(f"{message_type} payload must be an object")
            task_id = str(payload.get("taskId") or "").strip()
            if not task_id:
                raise RuntimeError(f"{message_type} requires payload.taskId")
            wf_path = pathlib.Path(workflow_path).expanduser().resolve()
            lock_path = wf_path.with_suffix(".lock")
            with workflow_mod.with_lock(lock_path):
                data = workflow_mod.load_json(wf_path)
                data.setdefault("scheduler", {})["controllerMode"] = "daemon"
                workflow_mod.update_scheduler_controller(
                    data,
                    daemonId=self.daemon_id,
                    daemonScope="global",
                    daemonPid=os.getpid(),
                    lastHeartbeatAt=now_iso(),
                    activeRequestId=request_id,
                )
                workflow_mod.apply_task_finish(
                    data,
                    task_id,
                    success=message_type == "task-finished",
                    summary=str(payload.get("summary") or ""),
                    result_commit=str(payload.get("resultCommit") or ""),
                    failure_reason=str(payload.get("failureReason") or ""),
                    no_op=bool(payload.get("noOp")),
                    stop_pending=bool(payload.get("stopPending")),
                )
                workflow_mod.append_history(
                    data,
                    "daemon_task_event",
                    {
                        "requestId": request_id,
                        "type": message_type,
                        "taskId": task_id,
                    },
                )
                workflow_mod.write_json(wf_path, data)
            trigger_request = {
                "type": "enqueue-trigger",
                "projectRoot": project_root,
                "workflow": workflow_path,
                "reason": "task-finished",
                "requestId": workflow_mod.sanitize_id(f"req-{time.time_ns()}"),
            }
            self.enqueue(trigger_request)
            return
        if message_type == "workflow-mutate":
            if not workflow_path:
                raise RuntimeError("workflow-mutate requires workflow path")
            wf_path = pathlib.Path(workflow_path).expanduser().resolve()
            lock_path = wf_path.with_suffix(".lock")
            payload = message.get("payload") or {}
            if not isinstance(payload, dict):
                raise RuntimeError("workflow-mutate payload must be an object")
            with workflow_mod.with_lock(lock_path):
                data = workflow_mod.load_json(wf_path)
                data.setdefault("scheduler", {})["controllerMode"] = "daemon"
                workflow_mod.update_scheduler_controller(
                    data,
                    daemonId=self.daemon_id,
                    daemonScope="global",
                    daemonPid=os.getpid(),
                    lastHeartbeatAt=now_iso(),
                    activeRequestId=request_id,
                )
                mutation_applied = workflow_mod.apply_workflow_mutation(data, payload, request_id=request_id)
                if mutation_applied:
                    task_payload = payload.get("task")
                    applied_task_id = ""
                    if isinstance(task_payload, dict):
                        applied_task_id = workflow_mod.sanitize_id(str(task_payload.get("id") or ""))
                    control_messages = data.setdefault("scheduler", {}).setdefault("controlMessages", [])
                    retained_messages: list[dict[str, Any]] = []
                    for item in control_messages:
                        if not isinstance(item, dict):
                            continue
                        item_request_id = str(item.get("requestId") or "")
                        if request_id and item_request_id == request_id:
                            continue
                        item_type = str(item.get("type") or "")
                        if applied_task_id and item_type == "add-task":
                            item_payload = item.get("payload")
                            item_task = item_payload.get("task") if isinstance(item_payload, dict) else None
                            item_task_id = (
                                workflow_mod.sanitize_id(str(item_task.get("id") or ""))
                                if isinstance(item_task, dict)
                                else ""
                            )
                            if item_task_id == applied_task_id:
                                continue
                        retained_messages.append(item)
                    data.setdefault("scheduler", {})["controlMessages"] = retained_messages
                    workflow_mod.append_history(
                        data,
                        "workflow_control_message",
                        {"requestId": request_id, "payload": payload, "applied": True},
                    )
                else:
                    control_messages = data.setdefault("scheduler", {}).setdefault("controlMessages", [])
                    control_messages.append(
                        {
                            "requestId": request_id,
                            "type": str(payload.get("type") or "message"),
                            "payload": payload,
                            "receivedAt": now_iso(),
                        }
                    )
                    workflow_mod.append_history(
                        data,
                        "workflow_control_message",
                        {"requestId": request_id, "payload": payload, "applied": False},
                    )
                workflow_mod.write_json(wf_path, data)
            trigger_request = {
                "type": "enqueue-trigger",
                "projectRoot": project_root,
                "workflow": workflow_path,
                "reason": "workflow-mutate",
                "requestId": workflow_mod.sanitize_id(f"req-{time.time_ns()}"),
            }
            self.enqueue(trigger_request)
            return
        if message_type == "shutdown":
            self.shutdown_event.set()
            return
        raise RuntimeError(f"unknown message type: {message_type}")

    def _worker_loop(self, key: str) -> None:
        """Drain one workflow-local queue and process messages serially."""

        while not self.shutdown_event.is_set():
            with self.queue_lock:
                event = self.queue_events[key]
            event.wait(POLL_INTERVAL_SECONDS)
            event.clear()
            while True:
                with self.queue_lock:
                    queue = self.workflow_queues.get(key)
                    message = queue.popleft() if queue else None
                if message is None:
                    break
                try:
                    self._handle_message(message)
                except Exception as exc:
                    self.log(f"message failed request={message.get('requestId')}: {exc}")
                finally:
                    workflow_path = str(message.get("workflow") or "").strip()
                    project_root = str(message.get("projectRoot") or "").strip()
                    if workflow_path:
                        self.active_workflows.add(workflow_path)
                    if project_root:
                        self.active_projects.add(project_root)
                    self.update_state(state="running")

    def _make_handler(self):
        """Build the tiny localhost HTTP control plane used by helper scripts."""

        daemon = self

        class Handler(BaseHTTPRequestHandler):
            def _send_json(self, status: int, payload: dict[str, Any]) -> None:
                body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _check_token(self) -> bool:
                return self.headers.get("X-Codex-Deck-Flow-Token", "") == daemon.token

            def do_POST(self) -> None:  # noqa: N802
                if not self._check_token():
                    self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                    return
                length = int(self.headers.get("Content-Length", "0") or "0")
                raw = self.rfile.read(length) if length else b"{}"
                try:
                    payload = json.loads(raw.decode("utf-8")) if raw else {}
                except Exception:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid json"})
                    return
                if not isinstance(payload, dict):
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": "payload must be object"})
                    return
                path = urlparse(self.path).path
                if path == "/enqueue":
                    try:
                        result = daemon.enqueue(payload)
                    except ValueError as exc:
                        self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                        return
                    self._send_json(HTTPStatus.OK, result)
                    return
                if path == "/shutdown":
                    daemon.shutdown_event.set()
                    with daemon.queue_lock:
                        for event in daemon.queue_events.values():
                            event.set()
                    self._send_json(HTTPStatus.OK, {"status": "stopping", "daemonId": daemon.daemon_id})
                    return
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

            def do_GET(self) -> None:  # noqa: N802
                path = urlparse(self.path).path
                if path == "/status":
                    if not self._check_token():
                        self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                        return
                    self._send_json(
                        HTTPStatus.OK,
                        {
                            "state": "running",
                            "scope": "global",
                            "daemonId": daemon.daemon_id,
                            "pid": os.getpid(),
                            "port": daemon.port,
                            "queueDepth": daemon.queue_depth(),
                            "activeProjects": sorted(daemon.active_projects),
                            "activeWorkflows": sorted(daemon.active_workflows),
                        },
                    )
                    return
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
                daemon.log(f"http {format % args}")

        return Handler

    def run(self) -> int:
        """Start the HTTP server and worker loops until shutdown is requested."""

        self.log(f"daemon starting daemonId={self.daemon_id}")
        self.server = ThreadingHTTPServer(("127.0.0.1", self.port), self._make_handler())
        self.server.timeout = HEARTBEAT_INTERVAL_SECONDS
        self.update_state(
            state="running",
            pid=os.getpid(),
            port=self.port,
            startedAt=now_iso(),
            daemonLogPath=str(self.log_path),
        )
        while not self.shutdown_event.is_set():
            self.server.handle_request()
            self.update_state(state="running")
        self.log("daemon shutting down")
        self.update_state(state="stopped", queueDepth=0)
        return 0


def spawn_daemon(project_root: pathlib.Path | None) -> int:
    """Start the global daemon process if one is not already running."""

    ensure_daemon_dir()
    with workflow_mod.with_lock(daemon_lock_path()):
        state = read_state()
        if state.get("state") == "running" and process_is_alive(int(state.get("pid") or 0)):
            print("already-running")
            return 0
        port = find_free_port()
        token = random_token()
        daemon_id = workflow_mod.sanitize_id(f"daemon-{time.time_ns()}")
        log_path = ensure_daemon_dir() / "daemon.log"
        write_state(
            None,
            {
                **default_state_payload(),
                "scope": "global",
                "daemonId": daemon_id,
                "state": "starting",
                "pid": None,
                "port": port,
                "token": token,
                "startedAt": now_iso(),
                "daemonLogPath": str(log_path),
                "queueDepth": 0,
                "activeProjects": [],
                "activeWorkflows": [],
            },
        )
        serve_project_root = pathlib.Path(project_root or pathlib.Path.cwd()).expanduser().resolve()
        cmd = [
            sys.executable,
            str(pathlib.Path(__file__).resolve()),
            "serve",
            "--project-root",
            str(serve_project_root),
            "--port",
            str(port),
            "--token",
            token,
            "--daemon-id",
            daemon_id,
        ]
        subprocess.Popen(cmd, cwd=str(serve_project_root), start_new_session=True)
    print("started")
    return 0


def stop_daemon(project_root: pathlib.Path | None) -> int:
    """Ask the global daemon to stop, falling back to SIGTERM if the control API fails."""

    from daemon_client import post_json

    del project_root
    state = read_state()
    if not (state.get("state") == "running" and process_is_alive(int(state.get("pid") or 0))):
        print("stopped")
        return 0
    try:
        post_json(None, "/shutdown", {})
    except Exception:
        pid = int(state.get("pid") or 0)
        if pid > 0:
            os.kill(pid, signal.SIGTERM)
    print("stopping")
    return 0


def daemon_status(project_root: pathlib.Path | None) -> int:
    payload = read_state()
    if project_root is not None:
        legacy_path = legacy_daemon_state_path(project_root)
        if legacy_path.exists():
            payload = dict(payload)
            payload["projectRoot"] = str(project_root)
            payload["legacyProjectDaemon"] = read_legacy_state(project_root)
            payload["legacyProjectDaemonPath"] = str(legacy_path)
    print(json.dumps(payload, ensure_ascii=True, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="codex-deck-flow daemon")
    sub = parser.add_subparsers(dest="cmd", required=True)

    start = sub.add_parser("start")
    start.add_argument("--project-root", default=".")
    start.set_defaults(func=lambda args: spawn_daemon(pathlib.Path(args.project_root).expanduser().resolve()))

    serve = sub.add_parser("serve")
    serve.add_argument("--project-root", default=".")
    serve.add_argument("--port", required=True, type=int)
    serve.add_argument("--token", required=True)
    serve.add_argument("--daemon-id", required=True)

    def serve_func(args: argparse.Namespace) -> int:
        del args.project_root
        daemon = WorkflowDaemon(int(args.port), str(args.token), ensure_daemon_dir() / "daemon.log", str(args.daemon_id))
        return daemon.run()

    serve.set_defaults(func=serve_func)

    stop = sub.add_parser("stop")
    stop.add_argument("--project-root", default=".")
    stop.set_defaults(func=lambda args: stop_daemon(pathlib.Path(args.project_root).expanduser().resolve()))

    status = sub.add_parser("status")
    status.add_argument("--project-root", default=".")
    status.set_defaults(func=lambda args: daemon_status(pathlib.Path(args.project_root).expanduser().resolve()))

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
