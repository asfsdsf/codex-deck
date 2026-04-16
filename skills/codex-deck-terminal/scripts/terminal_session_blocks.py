#!/usr/bin/env python3
"""Print the content backing one or more codex-deck terminal session blocks."""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from typing import Any

from terminal_session_lib import (
    TerminalSessionError,
    find_conversation_message_content,
    line_range_to_text,
    load_terminal_manifest,
    read_text_file,
    resolve_codex_home,
    resolve_manifest_content_path,
)


@dataclass(frozen=True)
class BlockRequest:
    selector: str
    line_start: int | None
    line_end: int | None
    has_line_range: bool


@dataclass(frozen=True)
class BlockContent:
    block_id: str
    block_type: str
    source: str
    text: str


def parse_line_range(value: str) -> tuple[int | None, int | None]:
    normalized = value.strip()
    if not normalized:
        return None, None

    match = re.match(r"^(\d*)\s*(?::|-)\s*(\d*)$", normalized)
    if match:
        start_text, end_text = match.groups()
        start = int(start_text) if start_text else None
        end = int(end_text) if end_text else None
    elif normalized.isdigit():
        start = int(normalized)
        end = start
    else:
        raise argparse.ArgumentTypeError(f"invalid line range: {value}")

    if start is not None and start < 1:
        raise argparse.ArgumentTypeError(f"line range start must be >= 1: {value}")
    if end is not None and end < 1:
        raise argparse.ArgumentTypeError(f"line range end must be >= 1: {value}")
    if start is not None and end is not None and end < start:
        raise argparse.ArgumentTypeError(f"line range end must be >= start: {value}")
    return start, end


def parse_block_request(value: str) -> BlockRequest:
    selector = value.strip()
    if not selector:
        raise argparse.ArgumentTypeError("block selector cannot be empty")

    line_start: int | None = None
    line_end: int | None = None
    has_line_range = False

    if "@" in selector:
        selector, range_text = selector.rsplit("@", 1)
        line_start, line_end = parse_line_range(range_text)
        has_line_range = True
    elif selector.count(":") == 1:
        maybe_selector, maybe_range = selector.rsplit(":", 1)
        if re.match(r"^\d+(?:-\d*)?$|^\d*-\d+$", maybe_range):
            selector = maybe_selector
            line_start, line_end = parse_line_range(maybe_range)
            has_line_range = True

    selector = selector.strip()
    if not selector:
        raise argparse.ArgumentTypeError("block selector cannot be empty")
    return BlockRequest(
        selector=selector,
        line_start=line_start,
        line_end=line_end,
        has_line_range=has_line_range,
    )


def block_id(block: dict[str, Any], fallback_index: int) -> str:
    value = block.get("blockId")
    if isinstance(value, str) and value.strip():
        return value.strip()
    value = block.get("entryId")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return str(fallback_index)


def resolve_block(blocks: list[Any], selector: str) -> tuple[int, dict[str, Any]]:
    for index, block in enumerate(blocks, start=1):
        if isinstance(block, dict) and block_id(block, index) == selector:
            return index, block

    if selector.isdigit():
        index = int(selector)
        if 1 <= index <= len(blocks) and isinstance(blocks[index - 1], dict):
            return index, blocks[index - 1]

    raise TerminalSessionError(f"block not found: {selector}")


def read_block_content(
    block: dict[str, Any],
    index: int,
    session_dir,
    codex_home,
) -> BlockContent:
    current_block_id = block_id(block, index)
    block_type = str(block.get("type") or "unknown")

    if block_type == "terminal-frozen-output":
        content_path = resolve_manifest_content_path(session_dir, block.get("path"))
        return BlockContent(
            block_id=current_block_id,
            block_type=block_type,
            source=str(content_path),
            text=read_text_file(content_path),
        )

    if block_type == "codex-session-message":
        session_id = block.get("sessionId")
        message_key = block.get("messageKey")
        if not isinstance(session_id, str) or not isinstance(message_key, str):
            raise TerminalSessionError(f"block {current_block_id} requires sessionId and messageKey")
        message = find_conversation_message_content(session_id, message_key, codex_home)
        return BlockContent(
            block_id=current_block_id,
            block_type=block_type,
            source=f"{message.session_file}:{message.line_number}",
            text=message.text,
        )

    if block_type == "codex-session-block-reference":
        frozen_artifact = block.get("frozenArtifact")
        if not isinstance(frozen_artifact, dict) or frozen_artifact.get("kind") != "terminal-frozen-output":
            raise TerminalSessionError(f"legacy block {current_block_id} has no terminal frozen artifact")
        content_path = resolve_manifest_content_path(session_dir, frozen_artifact.get("path"))
        return BlockContent(
            block_id=current_block_id,
            block_type=block_type,
            source=str(content_path),
            text=read_text_file(content_path),
        )

    raise TerminalSessionError(f"unsupported block type for {current_block_id}: {block_type}")


def print_block_content(content: BlockContent, line_start: int | None, line_end: int | None) -> None:
    visible_text = line_range_to_text(content.text, line_start, line_end)
    print(f"===== {content.block_id} ({content.block_type}) =====")
    print(f"source: {content.source}")
    if line_start is not None or line_end is not None:
        start_label = str(line_start) if line_start is not None else "1"
        end_label = str(line_end) if line_end is not None else "end"
        print(f"lines: {start_label}:{end_label}")
    print()
    if visible_text:
        print(visible_text)
        if not visible_text.endswith("\n"):
            print()
    print()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Show content for one or more blocks in a codex-deck terminal session. "
            "Use BLOCK_ID@START:END to choose a per-block one-based inclusive line range."
        ),
    )
    parser.add_argument("terminal_id", help="terminal session id under ~/.codex/codex-deck/terminal/sessions")
    parser.add_argument(
        "blocks",
        nargs="+",
        type=parse_block_request,
        metavar="BLOCK",
        help="block id or 1-based block index; append @START:END for a per-block line range",
    )
    parser.add_argument("--codex-home", default="", help="Codex home directory; defaults to ~/.codex")
    parser.add_argument(
        "--line-range",
        default="",
        type=parse_line_range,
        help="default one-based inclusive line range for block specs without their own range, e.g. 20:80",
    )
    args = parser.parse_args()

    codex_home = resolve_codex_home(args.codex_home or None)
    try:
        manifest_path, manifest = load_terminal_manifest(args.terminal_id, codex_home)
        blocks = manifest.get("blocks")
        if not isinstance(blocks, list):
            raise TerminalSessionError("terminal session manifest has no blocks array")

        default_range = args.line_range if args.line_range else (None, None)
        for request in args.blocks:
            index, block = resolve_block(blocks, request.selector)
            if request.has_line_range:
                line_start = request.line_start
                line_end = request.line_end
            else:
                line_start, line_end = default_range
            content = read_block_content(block, index, manifest_path.parent, codex_home)
            print_block_content(content, line_start, line_end)
    except (TerminalSessionError, argparse.ArgumentTypeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
