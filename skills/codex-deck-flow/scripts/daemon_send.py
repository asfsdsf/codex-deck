#!/usr/bin/env python3
"""CLI wrapper for sending one control message to the codex-deck-flow daemon."""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Any

from daemon_client import post_json


def parse_payload(raw: str) -> dict[str, Any]:
    """Parse payload input as inline JSON or as a path to a JSON file."""

    text = raw.strip()
    if not text:
        return {}
    path = pathlib.Path(text).expanduser()
    if path.exists() and path.is_file():
        text = path.read_text(encoding="utf-8")
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise ValueError("payload must be a JSON object")
    return parsed


def main() -> int:
    """Parse one CLI request and forward it to the daemon enqueue endpoint."""

    parser = argparse.ArgumentParser(description="Send a control message to the codex-deck-flow daemon")
    parser.add_argument("--project-root", default="")
    parser.add_argument("--workflow", default="")
    parser.add_argument("--type", required=True)
    parser.add_argument("--reason", default="manual")
    parser.add_argument("--payload-json", default="")
    args = parser.parse_args()

    workflow_path = pathlib.Path(args.workflow).expanduser().resolve() if args.workflow else ""
    project_root_arg = str(args.project_root or "").strip()
    if project_root_arg:
        project_root = pathlib.Path(project_root_arg).expanduser().resolve()
    elif workflow_path:
        project_root = workflow_path.parent.parent.resolve()
    else:
        project_root = pathlib.Path.cwd().resolve()
    payload = parse_payload(args.payload_json) if args.payload_json else {}
    body = {
        "type": args.type,
        "projectRoot": str(project_root),
        "workflow": str(workflow_path) if workflow_path else "",
        "reason": args.reason,
        "payload": payload,
    }
    result = post_json(project_root, "/enqueue", body)
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
