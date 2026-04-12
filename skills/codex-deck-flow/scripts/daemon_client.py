#!/usr/bin/env python3
"""Shared helpers for codex-deck-flow's daemon state and control requests."""

from __future__ import annotations

import json
import os
import pathlib
import secrets
import socket
import urllib.error
import urllib.request
from typing import Any


DAEMON_DIRNAME = "daemon"
GLOBAL_DAEMON_PARENT_DIRNAME = "codex-deck/workflows"
GLOBAL_DAEMON_DIRNAME = "daemon-state"
STATE_FILE = "state.json"
LOCK_FILE = "daemon.lock"
SCHEMA_VERSION = 2
LEGACY_SCHEMA_VERSION = 1


def project_daemon_dir(project_root: pathlib.Path) -> pathlib.Path:
    """Return the legacy project-local daemon directory."""

    return project_root / ".codex-deck" / DAEMON_DIRNAME


def legacy_daemon_state_path(project_root: pathlib.Path) -> pathlib.Path:
    return project_daemon_dir(project_root) / STATE_FILE


def legacy_daemon_lock_path(project_root: pathlib.Path) -> pathlib.Path:
    return project_daemon_dir(project_root) / LOCK_FILE


def daemon_home_dir() -> pathlib.Path:
    override = os.environ.get("CODEX_DECK_DAEMON_HOME", "").strip()
    if override:
        return pathlib.Path(override).expanduser().resolve()
    return (
        pathlib.Path.home()
        / ".codex"
        / GLOBAL_DAEMON_PARENT_DIRNAME
        / GLOBAL_DAEMON_DIRNAME
    ).resolve()

def daemon_dir(project_root: pathlib.Path | None = None) -> pathlib.Path:
    del project_root
    return daemon_home_dir()


def daemon_state_path(project_root: pathlib.Path | None = None) -> pathlib.Path:
    del project_root
    return daemon_dir() / STATE_FILE


def daemon_lock_path(project_root: pathlib.Path | None = None) -> pathlib.Path:
    del project_root
    return daemon_dir() / LOCK_FILE


def default_state_payload() -> dict[str, Any]:
    """Return the baseline schema written to the global daemon state file."""

    return {
        "schemaVersion": SCHEMA_VERSION,
        "scope": "global",
        "daemonId": None,
        "state": "stopped",
        "pid": None,
        "port": None,
        "token": None,
        "startedAt": None,
        "lastHeartbeatAt": None,
        "lastRequestAt": None,
        "daemonLogPath": None,
        "queueDepth": 0,
        "activeProjects": [],
        "activeWorkflows": [],
    }


def legacy_state_payload() -> dict[str, Any]:
    return {
        "schemaVersion": LEGACY_SCHEMA_VERSION,
        "state": "stopped",
        "pid": None,
        "port": None,
        "token": None,
        "startedAt": None,
        "lastHeartbeatAt": None,
        "lastRequestAt": None,
        "daemonLogPath": None,
        "activeWorkflows": [],
    }


def ensure_daemon_dir(project_root: pathlib.Path | None = None) -> pathlib.Path:
    del project_root
    current_daemon_dir = daemon_dir()
    current_daemon_dir.mkdir(parents=True, exist_ok=True)
    return current_daemon_dir


def ensure_project_daemon_dir(project_root: pathlib.Path) -> pathlib.Path:
    legacy_dir = project_daemon_dir(project_root)
    legacy_dir.mkdir(parents=True, exist_ok=True)
    return legacy_dir


def _read_json_file(path: pathlib.Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    return data


def read_state(project_root: pathlib.Path | None = None) -> dict[str, Any]:
    """Read global daemon state, tolerating missing or corrupted files."""

    del project_root
    data = _read_json_file(daemon_state_path())
    if data is None:
        return default_state_payload()
    merged = default_state_payload()
    merged.update(data)
    return merged


def read_legacy_state(project_root: pathlib.Path) -> dict[str, Any]:
    data = _read_json_file(legacy_daemon_state_path(project_root))
    if data is None:
        return legacy_state_payload()
    merged = legacy_state_payload()
    merged.update(data)
    return merged


def write_state(project_root: pathlib.Path | None, payload: dict[str, Any]) -> pathlib.Path:
    """Persist global daemon state and keep the file private to the local user."""

    del project_root
    ensure_daemon_dir()
    path = daemon_state_path()
    text = json.dumps(payload, ensure_ascii=True, indent=2) + "\n"
    path.write_text(text, encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return path


def write_legacy_state(project_root: pathlib.Path, payload: dict[str, Any]) -> pathlib.Path:
    ensure_project_daemon_dir(project_root)
    path = legacy_daemon_state_path(project_root)
    text = json.dumps(payload, ensure_ascii=True, indent=2) + "\n"
    path.write_text(text, encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return path


def process_is_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def daemon_is_running(project_root: pathlib.Path | None = None) -> bool:
    state = read_state(project_root)
    return str(state.get("state") or "") == "running" and process_is_alive(int(state.get("pid") or 0))


def random_token() -> str:
    return secrets.token_hex(16)


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        sock.listen(1)
        return int(sock.getsockname()[1])


def daemon_url(project_root: pathlib.Path | None, path: str) -> str:
    """Build the localhost control URL from the current daemon state file."""

    state = read_state(project_root)
    port = int(state.get("port") or 0)
    if port <= 0:
        raise RuntimeError("codex-deck-flow daemon has no control port")
    path_part = path if path.startswith("/") else f"/{path}"
    return f"http://127.0.0.1:{port}{path_part}"


def post_json(project_root: pathlib.Path | None, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Send one authenticated JSON request to the daemon."""

    state = read_state(project_root)
    token = str(state.get("token") or "")
    if not token:
        raise RuntimeError("codex-deck-flow daemon token missing")
    request_payload = dict(payload)
    if path == "/enqueue" and project_root is not None and not str(request_payload.get("projectRoot") or "").strip():
        request_payload["projectRoot"] = str(project_root.expanduser().resolve())
    req = urllib.request.Request(
        daemon_url(project_root, path),
        data=json.dumps(request_payload, ensure_ascii=True).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Codex-Deck-Flow-Token": token,
        },
        method="POST",
    )
    # The daemon always listens on localhost, so never route through env proxies.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=5) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(body or f"HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(str(exc.reason)) from exc
    try:
        parsed = json.loads(body)
    except Exception as exc:
        raise RuntimeError(f"invalid daemon response: {body!r}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("invalid daemon response type")
    return parsed
