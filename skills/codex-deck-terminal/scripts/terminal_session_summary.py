#!/usr/bin/env python3
"""Print a compact flow summary for a codex-deck terminal session."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from terminal_session_lib import (
    TerminalSessionError,
    block_type,
    first_chars,
    load_terminal_manifest,
    read_text_file,
    resolve_codex_home,
    resolve_block_snapshot_path,
    sanitize_terminal_snapshot_text,
)


def add_if_present(target: dict[str, Any], key: str, value: Any) -> None:
    if value is None:
        return
    if isinstance(value, str) and not value.strip():
        return
    if isinstance(value, list) and not value:
        return
    target[key] = value


def summarize_step(step: dict[str, Any]) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "stepId": step.get("stepId"),
        "command": step.get("command"),
        "risk": step.get("risk"),
        "nextAction": step.get("nextAction"),
    }
    add_if_present(summary, "stepGoal", step.get("stepGoal"))
    add_if_present(summary, "cwd", step.get("cwd"))
    add_if_present(summary, "shell", step.get("shell"))
    add_if_present(summary, "explanation", step.get("explanation"))
    add_if_present(summary, "contextNote", step.get("contextNote"))
    return summary


def summarize_step_action(action: dict[str, Any]) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "stepId": action.get("stepId"),
        "decision": action.get("decision"),
    }
    add_if_present(summary, "reason", action.get("reason"))
    return summary


def summarize_step_feedback(entry: dict[str, Any]) -> dict[str, Any]:
    kind = entry.get("kind")
    summary: dict[str, Any] = {
        "kind": kind,
        "stepId": entry.get("stepId"),
    }
    if kind == "execution":
        add_if_present(summary, "status", entry.get("status"))
        if entry.get("exitCode") is not None:
            summary["exitCode"] = entry.get("exitCode")
        add_if_present(summary, "cwdAfter", entry.get("cwdAfter"))
        add_if_present(summary, "outputSummary", entry.get("outputSummary"))
        add_if_present(summary, "errorSummary", entry.get("errorSummary"))
    elif kind == "rejection":
        add_if_present(summary, "reason", entry.get("reason"))
    return summary


def summarize_block(index: int, block: dict[str, Any], session_dir) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "index": index,
        "blockId": block.get("blockId"),
        "type": block_type(block),
    }

    block_type_value = block_type(block)
    if block_type_value == "terminal_snapshot":
        add_if_present(summary, "captureKind", block.get("captureKind"))
        add_if_present(summary, "stepId", block.get("stepId"))
        try:
            content_path = resolve_block_snapshot_path(block, session_dir)
            snapshot_text = read_text_file(content_path)
            handled_snapshot_text = sanitize_terminal_snapshot_text(snapshot_text)
            summary["snapshotPreview"] = first_chars(handled_snapshot_text)
        except TerminalSessionError as exc:
            summary["snapshotPreviewError"] = str(exc)
        return summary

    if block_type_value == "ai_terminal_plan":
        add_if_present(summary, "contextNote", block.get("contextNote"))
        add_if_present(summary, "leadingMarkdown", block.get("leadingMarkdown"))
        steps = block.get("steps")
        if isinstance(steps, list):
            summary["steps"] = [
                summarize_step(step) for step in steps if isinstance(step, dict)
            ]
        step_actions = block.get("stepActions")
        if isinstance(step_actions, list):
            summarized_actions = [
                summarize_step_action(action)
                for action in step_actions
                if isinstance(action, dict)
            ]
            add_if_present(summary, "stepActions", summarized_actions)
        step_feedback = block.get("stepFeedback")
        if isinstance(step_feedback, list):
            summarized_feedback = [
                summarize_step_feedback(entry)
                for entry in step_feedback
                if isinstance(entry, dict)
            ]
            add_if_present(summary, "stepFeedback", summarized_feedback)
        add_if_present(summary, "trailingMarkdown", block.get("trailingMarkdown"))
        return summary

    if block_type_value == "ai_terminal_need_input":
        add_if_present(summary, "question", block.get("question"))
        add_if_present(summary, "contextNote", block.get("contextNote"))
        add_if_present(summary, "leadingMarkdown", block.get("leadingMarkdown"))
        add_if_present(summary, "trailingMarkdown", block.get("trailingMarkdown"))
        return summary

    if block_type_value == "ai_terminal_complete":
        add_if_present(summary, "message", block.get("message"))
        add_if_present(summary, "leadingMarkdown", block.get("leadingMarkdown"))
        add_if_present(summary, "trailingMarkdown", block.get("trailingMarkdown"))
        return summary

    return summary


def build_summary(
    terminal_id: str,
    codex_home_arg: str | None,
    recent: int | None,
) -> dict[str, Any]:
    codex_home = resolve_codex_home(codex_home_arg)
    manifest_path, manifest = load_terminal_manifest(terminal_id, codex_home)
    session_dir = manifest_path.parent

    raw_blocks = manifest.get("blocks")
    blocks = raw_blocks if isinstance(raw_blocks, list) else []
    indexed_blocks = [
        (index, block)
        for index, block in enumerate(blocks, start=1)
        if isinstance(block, dict)
    ]
    if recent is not None:
        indexed_blocks = indexed_blocks[-recent:]

    latest_session_id = None
    if indexed_blocks:
        latest_session_id = indexed_blocks[-1][1].get("sessionId")
        if not isinstance(latest_session_id, str) or not latest_session_id.strip():
            latest_session_id = None

    return {
        "terminalId": manifest.get("terminalId") or terminal_id,
        "sessionId": latest_session_id,
        "blocks": [
            summarize_block(index, block, session_dir)
            for index, block in indexed_blocks
        ],
    }


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"invalid integer: {value}") from exc
    if parsed < 1:
        raise argparse.ArgumentTypeError("--recent must be >= 1")
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Show a compact flow summary of a codex-deck terminal session, "
            "optionally limited to the most recent N blocks."
        ),
    )
    parser.add_argument("terminal_id", help="terminal session id under ~/.codex/codex-deck/terminal/sessions")
    parser.add_argument("--codex-home", default="", help="Codex home directory; defaults to ~/.codex")
    parser.add_argument(
        "--recent",
        type=positive_int,
        default=None,
        help="show only the N most recent blocks",
    )
    args = parser.parse_args()

    try:
        summary = build_summary(
            args.terminal_id,
            args.codex_home or None,
            args.recent,
        )
    except TerminalSessionError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
