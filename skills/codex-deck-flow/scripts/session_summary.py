#!/usr/bin/env python3
"""Summarize a Codex session JSONL file using the codex-deck session-view format."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

TOOL_RESULT_MAX_LENGTH = 200_000
TURN_ABORTED_DEFAULT_TEXT = (
    "The user interrupted the previous turn on purpose. Any running unified exec "
    "processes may still be running in the background. If any tools/commands were "
    "aborted, they may have partially executed; verify current state before retrying."
)
TURN_ABORTED_DEFAULT_TEXT_VARIANTS = [
    TURN_ABORTED_DEFAULT_TEXT,
    (
        "The user interrupted the previous turn on purpose. Any running unified exec "
        "processes were terminated. If any tools/commands were aborted, they may have "
        "partially executed; verify current state before retrying."
    ),
    "This turn was interrupted before the assistant finished responding.",
]

IMPORTANT_TOOL_NAMES = {
    "request_user_input",
    "update_plan",
    "askuserquestion",
    "todowrite",
}

INVALID_JSON = object()

PROPOSED_PLAN_BLOCK_REGEX = re.compile(
    r"^<proposed_plan>\n([\s\S]*?)\n</proposed_plan>([\s\S]*)$"
)
PATCH_FILE_HEADER_REGEX = re.compile(r"^\*\*\* (Add|Update|Delete) File: (.+)$")
PATCH_MOVE_TO_HEADER_REGEX = re.compile(r"^\*\*\* Move to: (.+)$")
TURN_ABORTED_TAG_REGEX = re.compile(
    r"<turn_aborted>([\s\S]*?)</turn_aborted>|<turn_aborted\s*/>", re.IGNORECASE
)
SHELL_TOKEN_REGEX = re.compile(r'"[^"]*"|\'[^\']*\'|[^\s]+')
IMAGE_TAG_ONLY_TEXT_REGEX = re.compile(r"^</?image\b[^>]*>$", re.IGNORECASE)
AGENTS_INSTRUCTIONS_HEADER_REGEX = re.compile(
    r"^\s*#\s*AGENTS\.md instructions\b", re.IGNORECASE | re.MULTILINE
)
INSTRUCTIONS_BLOCK_REGEX = re.compile(
    r"<INSTRUCTIONS>[\s\S]*?</INSTRUCTIONS>", re.IGNORECASE
)

SANITIZE_PATTERNS = [
    re.compile(r"<command-name>[^<]*</command-name>"),
    re.compile(r"<command-message>[^<]*</command-message>"),
    re.compile(r"<command-args>[^<]*</command-args>"),
    re.compile(r"<local-command-stdout>[^<]*</local-command-stdout>"),
    re.compile(r"<system-reminder>[\s\S]*?</system-reminder>"),
    re.compile(r"^\s*Caveat:.*?unless the user explicitly asks you to\.", re.DOTALL),
]


@dataclass
class PendingToolUse:
    call_id: str
    name: str
    input: dict[str, Any]
    timestamp: str | None
    line_offset: int


@dataclass
class CollapsedViewportContext:
    project_path: str | None = None
    tool_map_by_call_id: dict[str, str] | None = None
    tool_input_map_by_call_id: dict[str, dict[str, Any]] | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Show a codex-deck style summary for a session file: important messages are "
            "expanded, and non-important messages are condensed to one text-mode line."
        )
    )
    parser.add_argument(
        "session",
        help=(
            "Session file path, or session id (searched under CODEX_HOME/sessions). "
            "When using session id, both file stem and session_meta.id are supported."
        ),
    )
    parser.add_argument(
        "--codex-home",
        dest="codex_home",
        default=None,
        help=(
         "Path to CODEX_HOME. If omitted, uses CODEX_HOME env var. If that is unset, "
            "uses the standard Codex default (~/.codex on Unix/macOS and %%USERPROFILE%%\\.codex on Windows)."
        ),
    )
    parser.add_argument(
        "--line-limit",
        type=int,
        default=180,
        help="Max length for one-line summaries of non-important messages (default: 180).",
    )
    return parser.parse_args()


def normalize_inline_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def truncate_inline_text(text: str, max_length: int = 180) -> str:
    if max_length <= 3:
        return "..." if text else ""
    if len(text) <= max_length:
        return text
    return f"{text[: max(0, max_length - 3)].rstrip()}..."


def sanitize_text(text: str) -> str:
    result = text
    for pattern in SANITIZE_PATTERNS:
        result = pattern.sub("", result)
    return result.strip()


def redact_agents_instructions_block(text: str) -> str:
    if not text:
        return text
    if not AGENTS_INSTRUCTIONS_HEADER_REGEX.search(text):
        return text
    return INSTRUCTIONS_BLOCK_REGEX.sub(
        "<INSTRUCTIONS>\n... (omitted)\n</INSTRUCTIONS>",
        text,
    )


def safe_json_parse(value: str) -> Any:
    try:
        return json.loads(value)
    except Exception:
        return INVALID_JSON


def is_record(value: Any) -> bool:
    return isinstance(value, dict)


def to_tool_input(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        parsed = safe_json_parse(value)
        if isinstance(parsed, dict):
            return parsed
        return {"raw": value}
    if value is None:
        return {}
    return {"value": value}


def truncate_tool_result(content: str) -> str:
    if len(content) <= TOOL_RESULT_MAX_LENGTH:
        return content
    omitted = len(content) - TOOL_RESULT_MAX_LENGTH
    return f"{content[:TOOL_RESULT_MAX_LENGTH]}\n... [truncated {omitted} chars]"


def to_tool_output_value(value: Any) -> Any:
    if isinstance(value, str):
        return truncate_tool_result(value)
    if value is None:
        return ""
    return value


def extract_content_blocks_from_payload_content(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}] if content.strip() else []

    if not isinstance(content, list):
        return []

    blocks: list[dict[str, Any]] = []
    for item in content:
        if not isinstance(item, dict):
            continue

        block_type = item.get("type")
        if block_type in {"input_text", "output_text"} and isinstance(item.get("text"), str):
            text = item["text"]
            if text.strip() and not IMAGE_TAG_ONLY_TEXT_REGEX.fullmatch(text.strip()):
                blocks.append({"type": "text", "text": text})
            continue

        if block_type == "input_image":
            image_url = item.get("image_url") if isinstance(item.get("image_url"), str) else item.get("imageUrl")
            if isinstance(image_url, str) and image_url.strip():
                blocks.append({"type": "image", "image_url": image_url})

    return blocks


def extract_text_from_reasoning_parts(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()

    if isinstance(value, list):
        parts = [extract_text_from_reasoning_parts(item) for item in value]
        return "\n\n".join(part for part in parts if part).strip()

    if not isinstance(value, dict):
        return ""

    if isinstance(value.get("text"), str):
        return value["text"].strip()

    if "summary" in value:
        summary_text = extract_text_from_reasoning_parts(value["summary"])
        if summary_text:
            return summary_text

    if "content" in value:
        return extract_text_from_reasoning_parts(value["content"])

    return ""


def extract_reasoning_text(payload: dict[str, Any]) -> str:
    summary_text = extract_text_from_reasoning_parts(payload.get("summary"))
    if summary_text:
        return summary_text
    return extract_text_from_reasoning_parts(payload.get("content"))


def normalize_reasoning_text(text: str) -> str:
    trimmed = text.strip()
    unwrapped = re.sub(r"^\*\*(.*?)\*\*$", r"\1", trimmed, flags=re.DOTALL)
    return re.sub(r"\s+", " ", unwrapped).strip().lower()


def normalize_comparable_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def is_default_turn_aborted_text(text: str) -> bool:
    normalized = normalize_comparable_text(text)
    return any(
        normalize_comparable_text(variant) == normalized
        for variant in TURN_ABORTED_DEFAULT_TEXT_VARIANTS
    )


def extract_turn_aborted_text(text: str) -> str | None:
    normalized = text.replace("\r\n", "\n")
    match = TURN_ABORTED_TAG_REGEX.search(normalized)
    if not match:
        return None
    group_text = (match.group(1) or "").strip()
    return group_text if group_text else TURN_ABORTED_DEFAULT_TEXT


def create_chat_message(
    role: str,
    content: list[dict[str, Any]],
    uuid: str,
    timestamp: str | None,
) -> dict[str, Any]:
    return {
        "type": role,
        "uuid": uuid,
        "timestamp": timestamp,
        "message": {"role": role, "content": content},
    }


def create_reasoning_message(
    message_type: str,
    text: str,
    uuid: str,
    timestamp: str | None,
) -> dict[str, Any]:
    return {
        "type": message_type,
        "uuid": uuid,
        "timestamp": timestamp,
        "message": {
            "role": "assistant",
            "content": [{"type": message_type, "text": text}],
        },
    }


def create_turn_aborted_message(
    text: str,
    uuid: str,
    timestamp: str | None,
    turn_id: str | None = None,
) -> dict[str, Any]:
    return {
        "type": "turn_aborted",
        "uuid": uuid,
        "turnId": turn_id,
        "timestamp": timestamp,
        "message": {"role": "assistant", "content": text},
    }


def create_system_error_message(
    title: str,
    text: str,
    uuid: str,
    timestamp: str | None,
) -> dict[str, Any]:
    return {
        "type": "system_error",
        "uuid": uuid,
        "timestamp": timestamp,
        "summary": title,
        "message": {"role": "assistant", "content": text},
    }


def create_tool_message(
    tool_use: PendingToolUse,
    uuid: str,
    result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    content: list[dict[str, Any]] = [
        {
            "type": "tool_use",
            "id": tool_use.call_id,
            "name": tool_use.name,
            "input": tool_use.input,
            "timestamp": tool_use.timestamp,
        }
    ]
    if result is not None:
        content.append(
            {
                "type": "tool_result",
                "tool_use_id": tool_use.call_id,
                "name": tool_use.name,
                "content": result.get("content"),
                "is_error": result.get("isError"),
                "timestamp": result.get("timestamp"),
            }
        )

    return {
        "type": "assistant",
        "uuid": uuid,
        "timestamp": tool_use.timestamp if tool_use.timestamp else result.get("timestamp") if result else None,
        "message": {"role": "assistant", "content": content},
    }


def create_tool_result_only_message(
    call_id: str,
    content: Any,
    uuid: str,
    timestamp: str | None,
    is_error: bool | None = None,
    name: str | None = None,
) -> dict[str, Any]:
    return {
        "type": "assistant",
        "uuid": uuid,
        "timestamp": timestamp,
        "message": {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": call_id,
                    "name": name,
                    "content": content,
                    "is_error": is_error,
                    "timestamp": timestamp,
                }
            ],
        },
    }


def get_reasoning_text_from_message(message: dict[str, Any]) -> str | None:
    message_type = message.get("type")
    if message_type not in {"reasoning", "agent_reasoning"}:
        return None

    content = message.get("message", {}).get("content")
    if not isinstance(content, list):
        return None

    for item in content:
        if not isinstance(item, dict):
            continue
        if item.get("type") in {"reasoning", "agent_reasoning"} and isinstance(item.get("text"), str):
            return item["text"]

    return None


def get_turn_aborted_text_from_message(message: dict[str, Any]) -> str | None:
    if message.get("type") != "turn_aborted":
        return None

    content = message.get("message", {}).get("content")
    if isinstance(content, str):
        text = content.strip()
        return text if text else None

    if isinstance(content, list):
        for item in content:
            if (
                isinstance(item, dict)
                and item.get("type") == "text"
                and isinstance(item.get("text"), str)
            ):
                text = item["text"].strip()
                if text:
                    return text

    return None


def get_system_error_comparable_text(message: dict[str, Any]) -> str | None:
    if message.get("type") != "system_error":
        return None

    title = message.get("summary")
    title_text = title.strip() if isinstance(title, str) else ""
    content = message.get("message", {}).get("content")

    details = ""
    if isinstance(content, str):
        details = content.strip()
    elif isinstance(content, list):
        chunks: list[str] = []
        for item in content:
            if (
                isinstance(item, dict)
                and item.get("type") == "text"
                and isinstance(item.get("text"), str)
            ):
                part = item["text"].strip()
                if part:
                    chunks.append(part)
        details = "\n".join(chunks)

    combined = "\n".join(part for part in [title_text, details] if part).strip()
    return combined if combined else None


def get_most_recent_visible_message_index(messages: list[dict[str, Any]]) -> int:
    for index in range(len(messages) - 1, -1, -1):
        candidate_type = messages[index].get("type")
        if candidate_type in {"task_started", "task_complete"}:
            continue
        return index
    return -1


def push_conversation_message(messages: list[dict[str, Any]], message: dict[str, Any]) -> None:
    message_type = message.get("type")

    if message_type in {"reasoning", "agent_reasoning"}:
        text = get_reasoning_text_from_message(message)
        last_text = get_reasoning_text_from_message(messages[-1]) if messages else None
        if text and last_text and normalize_reasoning_text(text) == normalize_reasoning_text(last_text):
            return

    if message_type == "turn_aborted":
        text = get_turn_aborted_text_from_message(message)
        last_index = get_most_recent_visible_message_index(messages)
        last_message = messages[last_index] if last_index >= 0 else None
        last_text = get_turn_aborted_text_from_message(last_message) if last_message else None

        if last_message and last_message.get("type") == "turn_aborted":
            if not text or not last_text:
                return
            if normalize_comparable_text(text) == normalize_comparable_text(last_text):
                return
            if is_default_turn_aborted_text(text):
                return
            if is_default_turn_aborted_text(last_text):
                messages[last_index] = message
                return
            return

    if message_type == "system_error":
        text = get_system_error_comparable_text(message)
        last_text = get_system_error_comparable_text(messages[-1]) if messages else None
        if text and last_text and normalize_comparable_text(text) == normalize_comparable_text(last_text):
            return

    messages.append(message)


def parse_tool_use_from_payload(
    payload: dict[str, Any], timestamp: str | None, offset: int
) -> PendingToolUse:
    payload_type = payload.get("type") if isinstance(payload.get("type"), str) else ""

    input_data: dict[str, Any] = {}
    if payload_type == "function_call":
        input_data = to_tool_input(payload.get("arguments"))
    elif payload_type == "custom_tool_call":
        input_data = to_tool_input(payload.get("input"))
    elif payload_type == "web_search_call":
        input_data = to_tool_input(payload.get("action"))

    if payload_type == "web_search_call":
        name = "web_search"
    elif isinstance(payload.get("name"), str):
        name = payload["name"]
    else:
        name = "unknown_tool"

    call_id_value = payload.get("call_id")
    if isinstance(call_id_value, str) and call_id_value:
        call_id = call_id_value
    else:
        call_id = f"{name}-{offset}"

    return PendingToolUse(
        call_id=call_id,
        name=name,
        input=input_data,
        timestamp=timestamp,
        line_offset=offset,
    )


def parse_tool_result_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    call_id_value = payload.get("call_id")
    call_id = call_id_value if isinstance(call_id_value, str) and call_id_value else f"unknown-call-{time.time_ns()}"

    is_error: bool | None
    if isinstance(payload.get("is_error"), bool):
        is_error = payload["is_error"]
    elif isinstance(payload.get("error"), bool):
        is_error = payload["error"]
    else:
        is_error = None

    return {
        "callId": call_id,
        "content": to_tool_output_value(payload.get("output")),
        "isError": is_error,
    }


def parse_codex_conversation(
    lines: list[tuple[str, int]],
    known_tool_names: dict[str, str] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    messages: list[dict[str, Any]] = []
    pending_tool_calls: dict[str, PendingToolUse] = {}
    tool_names = known_tool_names if known_tool_names is not None else {}

    for line, offset in lines:
        parsed = safe_json_parse(line)
        if not isinstance(parsed, dict):
            continue

        record_type = parsed.get("type")
        timestamp = parsed.get("timestamp") if isinstance(parsed.get("timestamp"), str) else None
        payload = parsed.get("payload")
        if not isinstance(payload, dict):
            continue

        payload_type = payload.get("type") if isinstance(payload.get("type"), str) else ""

        if record_type == "event_msg":
            if payload_type == "turn_aborted":
                reason = payload.get("reason").strip() if isinstance(payload.get("reason"), str) else ""
                turn_id = payload.get("turn_id").strip() if isinstance(payload.get("turn_id"), str) else ""
                text = (
                    TURN_ABORTED_DEFAULT_TEXT
                    if reason in {"", "interrupted"}
                    else f"Turn aborted ({reason}). {TURN_ABORTED_DEFAULT_TEXT}"
                )
                push_conversation_message(
                    messages,
                    create_turn_aborted_message(
                        text,
                        f"{offset}:turn-aborted-event:{len(messages)}",
                        timestamp,
                        turn_id if turn_id else None,
                    ),
                )
                continue

            if payload_type == "error":
                error_text = payload.get("message").strip() if isinstance(payload.get("message"), str) else ""
                if not error_text:
                    continue
                push_conversation_message(
                    messages,
                    create_system_error_message(
                        "Error",
                        error_text,
                        f"{offset}:system-error:{len(messages)}",
                        timestamp,
                    ),
                )
                continue

            if payload_type in {"context_compacted", "contextCompacted"}:
                push_conversation_message(
                    messages,
                    create_chat_message(
                        "assistant",
                        [{"type": "text", "text": "Context compacted"}],
                        f"{offset}:context-compacted:{len(messages)}",
                        timestamp,
                    ),
                )
                continue

            if payload_type == "task_started":
                turn_id = payload.get("turn_id").strip() if isinstance(payload.get("turn_id"), str) else ""
                push_conversation_message(
                    messages,
                    {
                        "type": "task_started",
                        "uuid": f"{offset}:task-started:{len(messages)}",
                        "turnId": turn_id if turn_id else None,
                        "timestamp": timestamp,
                    },
                )
                continue

            if payload_type == "task_complete":
                turn_id = payload.get("turn_id").strip() if isinstance(payload.get("turn_id"), str) else ""
                push_conversation_message(
                    messages,
                    {
                        "type": "task_complete",
                        "uuid": f"{offset}:task-complete:{len(messages)}",
                        "turnId": turn_id if turn_id else None,
                        "timestamp": timestamp,
                    },
                )
                continue

            if payload_type == "agent_reasoning":
                text = payload.get("text").strip() if isinstance(payload.get("text"), str) else ""
                if not text:
                    continue
                push_conversation_message(
                    messages,
                    create_reasoning_message(
                        "agent_reasoning",
                        text,
                        f"{offset}:agent-reasoning:{len(messages)}",
                        timestamp,
                    ),
                )
            continue

        if record_type != "response_item":
            continue

        if payload_type == "message":
            role = payload.get("role")
            if role not in {"user", "assistant"}:
                continue

            content_blocks = extract_content_blocks_from_payload_content(payload.get("content"))
            if not content_blocks:
                continue

            joined_text = (
                "\n\n".join(
                    block.get("text", "")
                    for block in content_blocks
                    if block.get("type") == "text" and isinstance(block.get("text"), str)
                ).strip()
            )

            turn_aborted_text = extract_turn_aborted_text(joined_text) if role == "user" else None
            if turn_aborted_text:
                push_conversation_message(
                    messages,
                    create_turn_aborted_message(
                        turn_aborted_text,
                        f"{offset}:turn-aborted-message:{len(messages)}",
                        timestamp,
                    ),
                )
                continue

            push_conversation_message(
                messages,
                create_chat_message(
                    role,
                    content_blocks,
                    f"{offset}:message:{len(messages)}",
                    timestamp,
                ),
            )
            continue

        if payload_type == "reasoning":
            text = extract_reasoning_text(payload)
            if not text:
                has_encrypted_content = (
                    isinstance(payload.get("encrypted_content"), str)
                    and payload["encrypted_content"].strip() != ""
                )
                if not has_encrypted_content:
                    continue
                text = "Encrypted reasoning captured in the session log"
            push_conversation_message(
                messages,
                create_reasoning_message(
                    "reasoning",
                    text,
                    f"{offset}:reasoning:{len(messages)}",
                    timestamp,
                ),
            )
            continue

        if payload_type in {"function_call", "custom_tool_call", "web_search_call"}:
            tool_use = parse_tool_use_from_payload(payload, timestamp, offset)
            pending_tool_calls[tool_use.call_id] = tool_use
            tool_names[tool_use.call_id] = tool_use.name

            if payload_type == "web_search_call" and "status" in payload:
                push_conversation_message(
                    messages,
                    create_tool_message(
                        tool_use,
                        f"{offset}:tool:{len(messages)}",
                        {"content": to_tool_output_value(payload.get("status"))},
                    ),
                )
                pending_tool_calls.pop(tool_use.call_id, None)
            continue

        if payload_type in {"function_call_output", "custom_tool_call_output"}:
            result = parse_tool_result_from_payload(payload)
            call_id = result["callId"]
            paired_tool_use = pending_tool_calls.get(call_id)
            tool_name = paired_tool_use.name if paired_tool_use else tool_names.get(call_id)

            if paired_tool_use:
                push_conversation_message(
                    messages,
                    create_tool_message(
                        paired_tool_use,
                        f"{offset}:tool-pair:{len(messages)}",
                        {
                            "content": result["content"],
                            "isError": result["isError"],
                            "timestamp": timestamp,
                        },
                    ),
                )
                pending_tool_calls.pop(call_id, None)
            else:
                push_conversation_message(
                    messages,
                    create_tool_result_only_message(
                        call_id,
                        result["content"],
                        f"{offset}:tool-result:{len(messages)}",
                        timestamp,
                        result.get("isError"),
                        tool_name,
                    ),
                )
            continue

    for pending in pending_tool_calls.values():
        push_conversation_message(
            messages,
            create_tool_message(
                pending,
                f"{pending.line_offset}:tool-pending:{len(messages)}",
            ),
        )

    return messages, tool_names


def collect_complete_conversation_lines(
    text: str, start_offset: int = 0
) -> tuple[list[tuple[str, int]], int]:
    lines: list[tuple[str, int]] = []
    consumed_bytes = 0
    current_offset = start_offset
    cursor = 0

    while cursor < len(text):
        newline_index = text.find("\n", cursor)
        has_newline = newline_index != -1
        line_end = newline_index if has_newline else len(text)
        line = text[cursor:line_end]
        line_bytes = len(line.encode("utf-8")) + (1 if has_newline else 0)

        if line.strip():
            parsed = safe_json_parse(line)
            if parsed is INVALID_JSON or parsed is None:
                break
            lines.append((line, current_offset))

        consumed_bytes += line_bytes
        current_offset += line_bytes

        if not has_newline:
            break
        cursor = newline_index + 1

    return lines, consumed_bytes


def parse_conversation_text_chunk(
    text: str, start_offset: int = 0, known_tool_names: dict[str, str] | None = None
) -> dict[str, Any]:
    lines, consumed_bytes = collect_complete_conversation_lines(text, start_offset)
    tool_names = known_tool_names if known_tool_names is not None else {}
    messages, tool_names = parse_codex_conversation(lines, tool_names)
    return {"messages": messages, "consumedBytes": consumed_bytes, "toolNames": tool_names}


def extract_non_empty_text_blocks(content: Any) -> list[str]:
    if not isinstance(content, list):
        return []
    text_blocks: list[str] = []
    for block in content:
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            normalized = normalize_inline_text(sanitize_text(block["text"]))
            if normalized:
                text_blocks.append(normalized)
    return text_blocks


def has_important_tool_use(content: Any) -> bool:
    if not isinstance(content, list):
        return False
    for block in content:
        if (
            block.get("type") == "tool_use"
            and isinstance(block.get("name"), str)
            and block["name"].lower() in IMPORTANT_TOOL_NAMES
        ):
            return True
    return False


def parse_plan_summary(text: str) -> str | None:
    normalized = text.replace("\r\n", "\n").strip()
    match = PROPOSED_PLAN_BLOCK_REGEX.match(normalized)
    if not match:
        return None

    plan_body = match.group(1).strip()
    if not plan_body:
        return None

    for line in plan_body.split("\n"):
        normalized_line = normalize_inline_text(line)
        if normalized_line:
            return normalized_line
    return "Plan proposal"


def get_first_string(input_data: dict[str, Any], keys: list[str]) -> str | None:
    for key in keys:
        value = input_data.get(key)
        if isinstance(value, str):
            normalized = normalize_inline_text(value)
            if normalized:
                return normalized
    return None


def get_tool_input_hint(input_data: Any) -> str | None:
    if not isinstance(input_data, dict):
        return None
    return get_first_string(
        input_data, ["command", "cmd", "path", "file_path", "query", "url", "message"]
    )


def to_display_path(file_path: str, project_path: str | None) -> str:
    normalized_path = file_path.strip().replace("\\", "/")
    if not normalized_path:
        return file_path

    normalized_project = project_path.strip().replace("\\", "/") if isinstance(project_path, str) else ""
    if normalized_project and (
        normalized_path == normalized_project
        or normalized_path.startswith(f"{normalized_project}/")
    ):
        return normalized_path[len(normalized_project) :].lstrip("/")
    return normalized_path


def stringify_compact_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        return str(value)


def parse_json_value(content: str) -> tuple[bool, Any]:
    trimmed = content.strip()
    if not trimmed:
        return False, None

    starts_like_json = (
        trimmed.startswith("{")
        or trimmed.startswith("[")
        or trimmed.startswith('"')
        or trimmed in {"null", "true", "false"}
        or re.match(r"^-?\d", trimmed) is not None
    )
    if not starts_like_json:
        return False, None

    parsed = safe_json_parse(trimmed)
    if parsed is INVALID_JSON:
        return False, None
    return True, parsed


def get_first_non_empty_line(value: str) -> str | None:
    for line in value.split("\n"):
        normalized = normalize_inline_text(line)
        if normalized:
            return normalized
    return None


def parse_patch_summary_rows(raw: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    current_row: dict[str, Any] | None = None

    for line in raw.replace("\r\n", "\n").split("\n"):
        header_match = PATCH_FILE_HEADER_REGEX.match(line)
        if header_match:
            operation_text = header_match.group(1).lower()
            operation = "add" if operation_text == "add" else "delete" if operation_text == "delete" else "update"
            current_row = {
                "operation": operation,
                "path": header_match.group(2).strip(),
                "movePath": None,
                "added": 0,
                "removed": 0,
            }
            rows.append(current_row)
            continue

        if current_row is None:
            continue

        move_match = PATCH_MOVE_TO_HEADER_REGEX.match(line)
        if move_match:
            current_row["movePath"] = move_match.group(1).strip()
            continue

        if line.startswith("+") and not line.startswith("+++"):
            current_row["added"] += 1
            continue

        if line.startswith("-") and not line.startswith("---"):
            current_row["removed"] += 1

    return rows


def build_patch_line(row: dict[str, Any], project_path: str | None) -> dict[str, Any]:
    operation = row["operation"]
    prefix = "Added" if operation == "add" else "Deleted" if operation == "delete" else "Edited"
    source_path = to_display_path(row["path"], project_path)
    if row["movePath"]:
        path_text = f"{source_path} → {to_display_path(row['movePath'], project_path)}"
    else:
        path_text = source_path
    return {"tone": "tool", "text": f"{prefix} {path_text} (+{row['added']} -{row['removed']})"}


def summarize_patch(raw: str, project_path: str | None) -> dict[str, Any] | None:
    rows = parse_patch_summary_rows(raw)
    if not rows:
        return None
    if len(rows) == 1:
        return build_patch_line(rows[0], project_path)
    added = sum(int(row["added"]) for row in rows)
    removed = sum(int(row["removed"]) for row in rows)
    return {"tone": "tool", "text": f"Edited {len(rows)} files (+{added} -{removed})"}


def get_command_text(input_data: dict[str, Any]) -> str | None:
    return get_first_string(input_data, ["command", "cmd", "chars"])


def shell_like_tokenize(command: str) -> list[str]:
    tokens = SHELL_TOKEN_REGEX.findall(command)
    cleaned: list[str] = []
    for token in tokens:
        if len(token) >= 2 and (
            (token.startswith('"') and token.endswith('"'))
            or (token.startswith("'") and token.endswith("'"))
        ):
            cleaned.append(token[1:-1])
        else:
            cleaned.append(token)
    return cleaned


def unwrap_shell_command(command: str) -> str:
    tokens = shell_like_tokenize(command.strip())
    if (
        len(tokens) >= 3
        and tokens[0] in {"bash", "sh", "zsh"}
        and tokens[1] in {"-lc", "-c"}
    ):
        return " ".join(tokens[2:]).strip()
    return command.strip()


def parse_sed_print_range(script: str) -> tuple[int, int] | None:
    single_line_match = re.match(r"^(\d+)p$", script)
    if single_line_match:
        line_number = int(single_line_match.group(1))
        return (line_number, line_number)

    range_match = re.match(r"^(\d+),(\d+)p$", script)
    if not range_match:
        return None
    return (int(range_match.group(1)), int(range_match.group(2)))


def summarize_frequent_command(command: str, project_path: str | None) -> dict[str, Any] | None:
    unwrapped = unwrap_shell_command(command)
    tokens = shell_like_tokenize(unwrapped)
    if not tokens:
        return None

    if tokens[0] == "sed" and len(tokens) >= 4 and tokens[1] == "-n":
        line_range = parse_sed_print_range(tokens[2])
        file_path = tokens[3]
        if line_range and file_path:
            display_path = to_display_path(file_path, project_path)
            range_text = (
                f"{line_range[0]}" if line_range[0] == line_range[1] else f"{line_range[0]}-{line_range[1]}"
            )
            return {"tone": "tool", "text": f"Read {display_path} :{range_text}"}

    if tokens[0] == "cat" and len(tokens) >= 2:
        redirect_index = -1
        for idx, token in enumerate(tokens):
            if token in {">", ">>"}:
                redirect_index = idx
                break
        if redirect_index >= 0:
            file_path = tokens[redirect_index + 1] if redirect_index + 1 < len(tokens) else ""
            if file_path:
                display_path = to_display_path(file_path, project_path)
                action = "Append" if tokens[redirect_index] == ">>" else "Write"
                return {"tone": "tool", "text": f"{action} {display_path}"}
        else:
            file_path = tokens[-1]
            display_path = to_display_path(file_path, project_path)
            return {"tone": "tool", "text": f"Read {display_path}"}

    if tokens[0] == "ls":
        target = next((token for i, token in enumerate(tokens) if i > 0 and not token.startswith("-")), ".")
        display_path = to_display_path(target, project_path)
        return {"tone": "tool", "text": f"List {display_path}"}

    if tokens[0] == "rg" and len(tokens) >= 2:
        pattern = next((token for i, token in enumerate(tokens) if i > 0 and not token.startswith("-")), None)
        if pattern:
            pattern_index = tokens.index(pattern)
            search_roots = [
                token
                for i, token in enumerate(tokens)
                if i > pattern_index and token and token != "--" and not token.startswith("-")
            ]
            location = search_roots[0] if search_roots else "."
            display_path = to_display_path(location, project_path)
            return {"tone": "tool", "text": f'Search "{pattern}" in {display_path}'}

    if len(tokens) >= 2 and tokens[0] == "git" and tokens[1] == "diff":
        target = next((token for i, token in enumerate(tokens) if i > 1 and not token.startswith("-")), "working tree")
        display_target = target if target == "working tree" else to_display_path(target, project_path)
        return {"tone": "tool", "text": f"Diff {display_target}"}

    return None


def summarize_command_tool_use(
    tool_name: str, input_data: dict[str, Any], context: CollapsedViewportContext
) -> dict[str, Any] | None:
    command = get_command_text(input_data)

    if tool_name == "write_stdin":
        session_text = f"session {input_data['session_id']}" if isinstance(input_data.get("session_id"), int) else ""
        if command and session_text:
            return {"tone": "tool", "text": f"Wrote to {session_text} · {command}"}
        if session_text:
            return {"tone": "tool", "text": f"Wrote to {session_text}"}

    if not command:
        return None

    customized = summarize_frequent_command(command, context.project_path)
    if customized:
        return customized

    return {"tone": "tool", "text": truncate_inline_text(command, 120)}


def summarize_command_tool_result(
    _tool_name: str, _content: str, _is_error: bool
) -> dict[str, Any] | None:
    return None


def summarize_tool_call(
    tool_name: str, input_data: dict[str, Any], context: CollapsedViewportContext
) -> dict[str, Any] | None:
    if tool_name in IMPORTANT_TOOL_NAMES:
        return None

    if tool_name == "apply_patch" and isinstance(input_data.get("raw"), str):
        return summarize_patch(input_data["raw"], context.project_path)

    if tool_name in {"exec_command", "bash", "write_stdin"}:
        return summarize_command_tool_use(tool_name, input_data, context)

    if tool_name == "wait" and isinstance(input_data.get("ids"), list):
        return {"tone": "tool", "text": f"Waiting for {len(input_data['ids'])} agent(s)"}

    if "web_search" in tool_name:
        query = get_first_string(input_data, ["query", "q", "url"])
        return {"tone": "tool", "text": f"Searching {query}" if query else "Searching the web"}

    if tool_name == "read":
        file_path = get_first_string(input_data, ["file_path", "path"])
        display_path = to_display_path(file_path, context.project_path) if file_path else "file"
        return {"tone": "tool", "text": f"Reading {display_path}"}

    if tool_name == "view_image":
        file_path = get_first_string(input_data, ["path"])
        display_path = to_display_path(file_path, context.project_path) if file_path else "image"
        return {"tone": "tool", "text": f"Viewing {display_path}"}

    if tool_name in {"spawn_agent", "task"}:
        summary = get_first_string(input_data, ["description", "message", "prompt"]) or "Task request"
        return {"tone": "tool", "text": f"Starting {truncate_inline_text(summary, 120)}"}

    hint = get_tool_input_hint(input_data)
    if hint:
        return {"tone": "tool", "text": f"Calling {tool_name}({truncate_inline_text(hint, 120)})"}

    serialized = truncate_inline_text(stringify_compact_json(input_data), 120)
    return {"tone": "tool", "text": f"Calling {tool_name}({serialized})"}


def summarize_tool_result(
    tool_name: str, block: dict[str, Any], context: CollapsedViewportContext
) -> dict[str, Any] | None:
    content_value = block.get("content")
    if isinstance(content_value, str):
        content = sanitize_text(content_value)
    elif isinstance(content_value, (dict, list)):
        content = json.dumps(content_value, ensure_ascii=False, indent=2)
    else:
        content = str(content_value if content_value is not None else "")
    is_error = block.get("is_error") is True

    if tool_name == "apply_patch":
        tool_use_id = block.get("tool_use_id")
        if (
            isinstance(tool_use_id, str)
            and isinstance(context.tool_input_map_by_call_id, dict)
            and isinstance(context.tool_input_map_by_call_id.get(tool_use_id), dict)
        ):
            patch_input = context.tool_input_map_by_call_id[tool_use_id]
            if isinstance(patch_input.get("raw"), str):
                return summarize_patch(patch_input["raw"], context.project_path)

    if tool_name in {"exec_command", "bash", "write_stdin"}:
        return summarize_command_tool_result(tool_name, content, is_error)

    if tool_name == "wait":
        parsed, value = parse_json_value(content)
        if parsed and isinstance(value, dict):
            if value.get("timed_out") is True:
                return {"tone": "system", "text": "Wait timed out"}
            if isinstance(value.get("status"), dict):
                return {"tone": "tool", "text": f"Received {len(value['status'].keys())} wait result(s)"}

    if tool_name == "view_image":
        parsed, value = parse_json_value(content)
        if parsed and isinstance(value, list):
            image_count = sum(
                1
                for item in value
                if isinstance(item, dict) and item.get("type") == "input_image"
            )
            if image_count > 0:
                suffix = "s" if image_count > 1 else ""
                return {"tone": "tool", "text": f"{image_count} image{suffix}"}

    first_line = get_first_non_empty_line(content)
    if first_line:
        truncated = truncate_inline_text(first_line, 120)
        if is_error:
            return {"tone": "system", "text": f"Error {tool_name} · {truncated}"}
        return {"tone": "tool", "text": f"Called {tool_name} · {truncated}"}

    if is_error:
        return {"tone": "system", "text": f"{tool_name} failed"}
    return {"tone": "tool", "text": f"Called {tool_name}"}


def get_assistant_inline_preview(
    content: Any, context: CollapsedViewportContext
) -> dict[str, Any] | None:
    if isinstance(content, str):
        sanitized = sanitize_text(content).strip()
        if not sanitized:
            return None
        plan_summary = parse_plan_summary(sanitized)
        if plan_summary:
            return {"tone": "plan", "text": f"Plan: {plan_summary}"}
        normalized = truncate_inline_text(normalize_inline_text(sanitized))
        return {"tone": "assistant", "text": normalized}

    if not isinstance(content, list):
        return None

    for block in content:
        if not isinstance(block, dict):
            continue

        block_type = block.get("type")
        if block_type == "text" and isinstance(block.get("text"), str):
            sanitized = sanitize_text(block["text"]).strip()
            if not sanitized:
                continue
            plan_summary = parse_plan_summary(sanitized)
            if plan_summary:
                return {"tone": "plan", "text": f"Plan: {plan_summary}"}
            normalized = truncate_inline_text(normalize_inline_text(sanitized))
            return {"tone": "assistant", "text": normalized}

        if block_type == "tool_use" and isinstance(block.get("name"), str):
            tool_name = normalize_inline_text(block["name"]).lower()
            if not tool_name or not isinstance(block.get("input"), dict):
                continue
            summary = summarize_tool_call(tool_name, block["input"], context)
            if summary:
                return summary
            continue

        if block_type == "tool_result":
            candidate_name = block.get("name")
            if not isinstance(candidate_name, str):
                tool_use_id = block.get("tool_use_id")
                if (
                    isinstance(tool_use_id, str)
                    and isinstance(context.tool_map_by_call_id, dict)
                ):
                    candidate_name = context.tool_map_by_call_id.get(tool_use_id) or ""
                else:
                    candidate_name = ""
            tool_name = normalize_inline_text(candidate_name).lower()
            if not tool_name or tool_name in IMPORTANT_TOOL_NAMES:
                continue
            summary = summarize_tool_result(tool_name, block, context)
            if summary:
                return summary
            continue

        if block_type == "image" and isinstance(block.get("image_url"), str) and block["image_url"].strip():
            return {"tone": "assistant", "text": "Image attachment"}

    return None


def has_assistant_primary_text(content: Any) -> bool:
    if isinstance(content, str):
        return bool(normalize_inline_text(sanitize_text(content)))
    if not isinstance(content, list):
        return False
    return len(extract_non_empty_text_blocks(content)) > 0


def get_viewport_message_group(message: dict[str, Any]) -> str:
    message_type = message.get("type")
    if message_type in {"user", "system_error", "turn_aborted"}:
        return "important"

    if message_type != "assistant":
        return "default"

    content = message.get("message", {}).get("content")
    if has_assistant_primary_text(content):
        return "important"
    if isinstance(content, list) and has_important_tool_use(content):
        return "important"
    return "default"


def get_collapsed_viewport_line(
    message: dict[str, Any], context: CollapsedViewportContext
) -> dict[str, Any] | None:
    message_type = message.get("type")
    if message_type in {"reasoning", "agent_reasoning"}:
        return None

    content = message.get("message", {}).get("content")

    if message_type == "assistant":
        return get_assistant_inline_preview(content, context)

    if message_type == "user":
        if isinstance(content, str):
            user_text = normalize_inline_text(sanitize_text(content))
        elif isinstance(content, list):
            text_blocks = extract_non_empty_text_blocks(content)
            user_text = text_blocks[0] if text_blocks else ""
        else:
            user_text = ""
        if not user_text:
            return None
        return {"tone": "user", "text": truncate_inline_text(user_text)}

    if message_type in {"system_error", "turn_aborted"}:
        fallback = normalize_inline_text(sanitize_text(message.get("summary", "") if isinstance(message.get("summary"), str) else ""))
        if isinstance(content, str):
            details = normalize_inline_text(sanitize_text(content))
        elif isinstance(content, list):
            details = extract_non_empty_text_blocks(content)[0] if extract_non_empty_text_blocks(content) else ""
        else:
            details = ""
        text = truncate_inline_text(details or fallback or "System message")
        return {"tone": "system", "text": text}

    return None


def get_first_line(path: Path) -> str | None:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            return handle.readline()
    except Exception:
        return None


def parse_session_meta_line(line: str) -> dict[str, Any] | None:
    parsed = safe_json_parse(line)
    if not isinstance(parsed, dict):
        return None
    if parsed.get("type") != "session_meta":
        return None
    payload = parsed.get("payload")
    if not isinstance(payload, dict):
        return None
    session_id = payload.get("id").strip() if isinstance(payload.get("id"), str) else ""
    if not session_id:
        return None
    cwd = payload.get("cwd").strip() if isinstance(payload.get("cwd"), str) else ""
    return {"id": session_id, "cwd": cwd}


def resolve_codex_home(args_codex_home: str | None) -> Path:
    if args_codex_home:
        return Path(args_codex_home).expanduser().resolve()

    env_codex_home = os.environ.get("CODEX_HOME", "").strip()
    if env_codex_home:
        return Path(env_codex_home).expanduser().resolve()

    # Use the standard Codex home directory convention.
    return (Path.home() / ".codex").resolve()


def resolve_session_path(session_arg: str, codex_home: Path) -> Path:
    candidate = Path(session_arg).expanduser()
    if candidate.is_file():
        return candidate.resolve()
    if candidate.suffix != ".jsonl" and candidate.with_suffix(".jsonl").is_file():
        return candidate.with_suffix(".jsonl").resolve()

    sessions_dir = codex_home / "sessions"
    direct = sessions_dir / session_arg
    if direct.is_file():
        return direct.resolve()
    if direct.suffix != ".jsonl" and direct.with_suffix(".jsonl").is_file():
        return direct.with_suffix(".jsonl").resolve()

    if not sessions_dir.is_dir():
        raise FileNotFoundError(f"sessions directory not found: {sessions_dir}")

    normalized = session_arg.strip()
    if not normalized:
        raise FileNotFoundError("empty session id")

    files = sorted(p for p in sessions_dir.rglob("*.jsonl") if p.is_file())
    for file_path in files:
        if file_path.stem == normalized or file_path.name == normalized:
            return file_path.resolve()
        if file_path.name == f"{normalized}.jsonl":
            return file_path.resolve()

    for file_path in files:
        first_line = get_first_line(file_path)
        if not first_line:
            continue
        meta = parse_session_meta_line(first_line)
        if meta and meta.get("id") == normalized:
            return file_path.resolve()

    raise FileNotFoundError(
        f"session not found: {session_arg} (searched path, filename/stem, and session_meta.id under {sessions_dir})"
    )


def extract_project_path_from_session_meta(session_path: Path) -> str | None:
    first_line = get_first_line(session_path)
    if not first_line:
        return None
    meta = parse_session_meta_line(first_line)
    if not meta:
        return None
    cwd = meta.get("cwd")
    return cwd if isinstance(cwd, str) and cwd else None


def build_context(
    messages: list[dict[str, Any]], project_path: str | None
) -> CollapsedViewportContext:
    tool_map: dict[str, str] = {}
    tool_input_map: dict[str, dict[str, Any]] = {}

    for message in messages:
        content = message.get("message", {}).get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            call_id = block.get("id")
            name = block.get("name")
            input_data = block.get("input")
            if isinstance(call_id, str):
                if isinstance(name, str):
                    tool_map[call_id] = name
                if isinstance(input_data, dict):
                    tool_input_map[call_id] = input_data

    return CollapsedViewportContext(
        project_path=project_path,
        tool_map_by_call_id=tool_map,
        tool_input_map_by_call_id=tool_input_map,
    )


def extract_text_parts_from_content(content: Any) -> list[str]:
    parts: list[str] = []
    if isinstance(content, str):
        sanitized = sanitize_text(content).strip()
        if sanitized:
            parts.append(sanitized)
        return parts

    if not isinstance(content, list):
        return parts

    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            sanitized = sanitize_text(block["text"]).strip()
            if sanitized:
                parts.append(sanitized)
        elif (
            block.get("type") == "image"
            and isinstance(block.get("image_url"), str)
            and block["image_url"].strip()
        ):
            parts.append("Image attachment")

    return parts


def extract_important_message_text(
    message: dict[str, Any], context: CollapsedViewportContext
) -> str:
    message_type = message.get("type")
    content = message.get("message", {}).get("content")

    if message_type == "system_error":
        title = message.get("summary").strip() if isinstance(message.get("summary"), str) else "Error"
        details = "\n\n".join(extract_text_parts_from_content(content)).strip()
        if details and title:
            return f"{title}\n{details}"
        return details or title

    if message_type == "turn_aborted":
        details = "\n\n".join(extract_text_parts_from_content(content)).strip()
        return details or TURN_ABORTED_DEFAULT_TEXT

    if message_type in {"user", "assistant"}:
        parts = extract_text_parts_from_content(content)
        if parts:
            return "\n\n".join(parts).strip()

        if isinstance(content, list):
            important_tool_lines: list[str] = []
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") != "tool_use" or not isinstance(block.get("name"), str):
                    continue
                tool_name = normalize_inline_text(block["name"]).lower()
                if tool_name not in IMPORTANT_TOOL_NAMES:
                    continue
                input_data = block.get("input") if isinstance(block.get("input"), dict) else {}
                question_like = get_first_string(
                    input_data, ["question", "prompt", "message", "description"]
                )
                if question_like:
                    important_tool_lines.append(f"{tool_name}: {question_like}")
                else:
                    important_tool_lines.append(f"{tool_name}: {stringify_compact_json(input_data)}")
            if important_tool_lines:
                return "\n".join(important_tool_lines)

        fallback = get_collapsed_viewport_line(message, context)
        return fallback["text"] if fallback else ""

    fallback = get_collapsed_viewport_line(message, context)
    return fallback["text"] if fallback else ""


def format_timestamp(timestamp: Any) -> str:
    return f"[{timestamp}] " if isinstance(timestamp, str) and timestamp.strip() else ""


def render_summary(
    messages: list[dict[str, Any]],
    context: CollapsedViewportContext,
    line_limit: int,
) -> list[str]:
    output: list[str] = []
    for message in messages:
        group = get_viewport_message_group(message)
        timestamp_label = format_timestamp(message.get("timestamp"))

        if group == "important":
            kind = str(message.get("type", "message")).upper()
            text = extract_important_message_text(message, context).strip()
            text = redact_agents_instructions_block(text).strip()
            if not text:
                continue
            lines = text.splitlines()
            output.append(f"! {timestamp_label}{kind}: {lines[0]}")
            for extra in lines[1:]:
                if extra.strip():
                    output.append(f"  {extra}")
            continue

        collapsed = get_collapsed_viewport_line(message, context)
        if not collapsed:
            continue
        collapsed_text = normalize_inline_text(str(collapsed.get("text", "")))
        if not collapsed_text:
            continue
        collapsed_text = truncate_inline_text(collapsed_text, line_limit)
        tone = str(collapsed.get("tone", "message"))
        output.append(f"- {timestamp_label}{tone}: {collapsed_text}")

    return output


def main() -> int:
    args = parse_args()
    if args.line_limit < 8:
        print("error: --line-limit must be at least 8", file=sys.stderr)
        return 2

    codex_home = resolve_codex_home(args.codex_home)
    try:
        session_path = resolve_session_path(args.session, codex_home)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    try:
        text = session_path.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        print(f"error: failed to read {session_path}: {exc}", file=sys.stderr)
        return 1

    parsed = parse_conversation_text_chunk(text, 0, {})
    messages: list[dict[str, Any]] = parsed["messages"]
    project_path = extract_project_path_from_session_meta(session_path)
    context = build_context(messages, project_path)
    rendered_lines = render_summary(messages, context, args.line_limit)

    print(f"Session file: {session_path}")
    print(f"CODEX_HOME:   {codex_home}")
    if project_path:
        print(f"Project cwd:  {project_path}")
    print(f"Messages:     {len(messages)} parsed, {len(rendered_lines)} summary lines shown")
    print("")

    if not rendered_lines:
        print("(no visible summary lines)")
        return 0

    for line in rendered_lines:
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
