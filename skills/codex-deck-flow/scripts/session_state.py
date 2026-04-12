#!/usr/bin/env python3
"""Derive workflow-oriented status flags from a Codex session JSONL file."""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Any

NOOP_MARKERS = (
    "[codex-deck:no-op]",
    "no-op",
    "noop",
    "no changes required",
    "already implemented",
    "already complete",
    "nothing to change",
)
STOP_PENDING_MARKERS = (
    "[codex-deck:stop-pending]",
)


def load_jsonl(path: pathlib.Path) -> list[dict[str, Any]]:
    """Load JSONL records from a Codex session file, skipping bad lines."""

    out: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except Exception:
            continue
        if isinstance(parsed, dict):
            out.append(parsed)
    return out


def resolve_session_file(session_id: str, codex_home: pathlib.Path) -> pathlib.Path:
    """Locate a session file by filename first, then by the JSON payload id."""

    sessions_dir = codex_home / "sessions"
    if not sessions_dir.is_dir():
        raise FileNotFoundError(f"sessions directory not found: {sessions_dir}")
    files = sorted(sessions_dir.rglob("*.jsonl"))
    for file_path in files:
        if file_path.stem == session_id or file_path.name == f"{session_id}.jsonl":
            return file_path
    for file_path in files:
        try:
            first = file_path.read_text(encoding="utf-8", errors="replace").splitlines()[0]
            parsed = json.loads(first)
        except Exception:
            continue
        payload = parsed.get("payload", {}) if isinstance(parsed, dict) else {}
        if isinstance(payload, dict) and payload.get("id") == session_id:
            return file_path
    raise FileNotFoundError(f"session not found: {session_id}")


def summarize_text(items: list[dict[str, Any]]) -> str:
    """Collect recent assistant text blocks as the human-readable task summary."""

    texts: list[str] = []
    for item in items:
        if item.get("type") != "response_item":
            continue
        payload = item.get("payload")
        if not isinstance(payload, dict):
            continue
        if payload.get("type") != "message":
            continue
        if payload.get("role") != "assistant":
            continue
        for block in payload.get("content", []):
            if isinstance(block, dict) and block.get("type") in {"output_text", "text"}:
                text = str(block.get("text") or "").strip()
                if text:
                    texts.append(text)
    return "\n\n".join(texts[-4:]).strip()


def detect_status(items: list[dict[str, Any]]) -> tuple[str, str | None, bool, bool]:
    """Translate raw session events and markers into workflow result flags."""

    task_complete = any(
        item.get("type") == "event_msg"
        and isinstance(item.get("payload"), dict)
        and item["payload"].get("type") == "task_complete"
        for item in items
    )
    task_started = any(
        item.get("type") == "event_msg"
        and isinstance(item.get("payload"), dict)
        and item["payload"].get("type") == "task_started"
        for item in items
    )

    summary = summarize_text(items)
    lower = summary.lower()
    # Summary markers provide workflow-specific overrides even when the raw
    # event stream is sparse, which is why no-op wins over generic completion.
    no_op = any(marker in lower for marker in NOOP_MARKERS)
    stop_pending = any(marker in lower for marker in STOP_PENDING_MARKERS)
    if no_op:
        return ("completed_noop", summary, no_op, stop_pending)
    if task_complete:
        return ("completed", summary, no_op, stop_pending)
    if task_started:
        return ("running", summary, no_op, stop_pending)
    return ("unknown", summary, no_op, stop_pending)


def main() -> int:
    parser = argparse.ArgumentParser(description="Get workflow-oriented state from a codex session")
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--codex-home", default="")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    codex_home = pathlib.Path(args.codex_home).expanduser().resolve() if args.codex_home else (pathlib.Path.home() / ".codex").resolve()
    try:
        session_file = resolve_session_file(args.session_id, codex_home)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    items = load_jsonl(session_file)
    status, summary, no_op, stop_pending = detect_status(items)
    result = {
        "sessionId": args.session_id,
        "sessionFile": str(session_file),
        "status": status,
        "summary": summary or "",
        "noOp": no_op,
        "stopPending": stop_pending,
    }

    if args.json:
        print(json.dumps(result, ensure_ascii=True))
    else:
        print(f"session: {result['sessionId']}")
        print(f"status:  {result['status']}")
        print(f"file:    {result['sessionFile']}")
        if result["summary"]:
            print("summary:")
            print(result["summary"])

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
