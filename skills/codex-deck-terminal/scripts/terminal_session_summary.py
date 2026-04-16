#!/usr/bin/env python3
"""Print an enriched codex-deck terminal session manifest."""

from __future__ import annotations

import argparse
import copy
import json
import sys
from typing import Any

from terminal_session_lib import (
    TerminalSessionError,
    find_conversation_message_content,
    first_chars,
    load_terminal_manifest,
    read_text_file,
    resolve_codex_home,
    resolve_manifest_content_path,
)


def enrich_block(block: dict[str, Any], session_dir, codex_home) -> dict[str, Any]:
    enriched = copy.deepcopy(block)
    block_type = enriched.get("type")

    if block_type == "terminal-frozen-output":
        try:
            content_path = resolve_manifest_content_path(session_dir, enriched.get("path"))
            enriched["contentPreview"] = first_chars(read_text_file(content_path))
        except TerminalSessionError as exc:
            enriched["contentPreviewError"] = str(exc)
        return enriched

    if block_type == "codex-session-message":
        session_id = enriched.get("sessionId")
        message_key = enriched.get("messageKey")
        if isinstance(session_id, str) and isinstance(message_key, str):
            try:
                message = find_conversation_message_content(session_id, message_key, codex_home)
                enriched["contentPreview"] = first_chars(message.text)
            except TerminalSessionError as exc:
                enriched["contentPreviewError"] = str(exc)
        else:
            enriched["contentPreviewError"] = "codex-session-message block requires sessionId and messageKey"
        return enriched

    if block_type == "codex-session-block-reference":
        frozen_artifact = enriched.get("frozenArtifact")
        if isinstance(frozen_artifact, dict) and frozen_artifact.get("kind") == "terminal-frozen-output":
            try:
                content_path = resolve_manifest_content_path(session_dir, frozen_artifact.get("path"))
                enriched["contentPreview"] = first_chars(read_text_file(content_path))
            except TerminalSessionError as exc:
                enriched["contentPreviewError"] = str(exc)
    return enriched


def build_summary(terminal_id: str, codex_home_arg: str | None) -> dict[str, Any]:
    codex_home = resolve_codex_home(codex_home_arg)
    manifest_path, manifest = load_terminal_manifest(terminal_id, codex_home)
    session_dir = manifest_path.parent

    enriched = copy.deepcopy(manifest)
    blocks = enriched.get("blocks")
    if isinstance(blocks, list):
        enriched["blocks"] = [
            enrich_block(block, session_dir, codex_home) if isinstance(block, dict) else block
            for block in blocks
        ]
    return enriched


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Show a codex-deck terminal session.json manifest with 1000-character "
            "contentPreview fields for frozen output and codex session message blocks."
        ),
    )
    parser.add_argument("terminal_id", help="terminal session id under ~/.codex/codex-deck/terminal/sessions")
    parser.add_argument("--codex-home", default="", help="Codex home directory; defaults to ~/.codex")
    args = parser.parse_args()

    try:
        summary = build_summary(args.terminal_id, args.codex_home or None)
    except TerminalSessionError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
