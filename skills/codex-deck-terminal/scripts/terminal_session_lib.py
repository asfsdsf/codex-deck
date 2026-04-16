#!/usr/bin/env python3
"""Shared helpers for inspecting codex-deck terminal session artifacts."""

from __future__ import annotations

import json
import pathlib
import re
from dataclasses import dataclass
from typing import Any, Iterable

TERMINAL_SESSIONS_RELATIVE_DIR = pathlib.Path("codex-deck/terminal/sessions")
TERMINAL_SESSION_MANIFEST_FILE = "session.json"
PREVIEW_CHAR_LIMIT = 1000


class TerminalSessionError(RuntimeError):
    """Raised when a terminal session artifact cannot be resolved."""


@dataclass(frozen=True)
class JsonlRecord:
    offset: int
    line_number: int
    record: dict[str, Any]


@dataclass(frozen=True)
class ConversationMessageContent:
    key: str
    text: str
    session_file: pathlib.Path
    line_number: int
    offset: int


def resolve_codex_home(value: str | None = None) -> pathlib.Path:
    if value and value.strip():
        return pathlib.Path(value).expanduser().resolve()
    return (pathlib.Path.home() / ".codex").resolve()


def terminal_session_dir(terminal_id: str, codex_home: pathlib.Path) -> pathlib.Path:
    normalized = terminal_id.strip()
    if not normalized:
        raise TerminalSessionError("terminal session id is required")
    return codex_home / TERMINAL_SESSIONS_RELATIVE_DIR / normalized


def terminal_manifest_path(terminal_id: str, codex_home: pathlib.Path) -> pathlib.Path:
    return terminal_session_dir(terminal_id, codex_home) / TERMINAL_SESSION_MANIFEST_FILE


def load_terminal_manifest(
    terminal_id: str,
    codex_home: pathlib.Path,
) -> tuple[pathlib.Path, dict[str, Any]]:
    manifest_path = terminal_manifest_path(terminal_id, codex_home)
    if not manifest_path.is_file():
        raise TerminalSessionError(f"terminal session manifest not found: {manifest_path}")
    try:
        parsed = json.loads(manifest_path.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError as exc:
        raise TerminalSessionError(f"invalid terminal session manifest JSON: {manifest_path}: {exc}") from exc
    if not isinstance(parsed, dict):
        raise TerminalSessionError(f"terminal session manifest must contain a JSON object: {manifest_path}")
    return manifest_path, parsed


def first_chars(value: str, limit: int = PREVIEW_CHAR_LIMIT) -> str:
    return value[:limit]


def is_relative_to(path: pathlib.Path, parent: pathlib.Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def resolve_manifest_content_path(session_dir: pathlib.Path, value: Any) -> pathlib.Path:
    if not isinstance(value, str) or not value.strip():
        raise TerminalSessionError("block path is empty")

    raw_path = pathlib.Path(value.strip()).expanduser()
    if raw_path.is_absolute():
        return raw_path.resolve()

    resolved = (session_dir / raw_path).resolve()
    resolved_session_dir = session_dir.resolve()
    if not is_relative_to(resolved, resolved_session_dir):
        raise TerminalSessionError(f"block path escapes terminal session directory: {value}")
    return resolved


def read_text_file(path: pathlib.Path) -> str:
    if not path.is_file():
        raise TerminalSessionError(f"content file not found: {path}")
    return path.read_text(encoding="utf-8", errors="replace")


def load_jsonl_records(path: pathlib.Path) -> list[JsonlRecord]:
    records: list[JsonlRecord] = []
    offset = 0
    with path.open("rb") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            line_offset = offset
            offset += len(raw_line)
            text = raw_line.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                records.append(JsonlRecord(offset=line_offset, line_number=line_number, record=parsed))
    return records


def resolve_session_file(session_id: str, codex_home: pathlib.Path) -> pathlib.Path:
    normalized = session_id.strip()
    if not normalized:
        raise TerminalSessionError("codex session id is required")

    sessions_dir = codex_home / "sessions"
    if not sessions_dir.is_dir():
        raise TerminalSessionError(f"codex sessions directory not found: {sessions_dir}")

    files = sorted(sessions_dir.rglob("*.jsonl"))
    for file_path in files:
        if file_path.stem == normalized or file_path.name == f"{normalized}.jsonl":
            return file_path

    for file_path in files:
        try:
            records = load_jsonl_records(file_path)
        except OSError:
            continue
        if not records:
            continue
        payload = records[0].record.get("payload")
        if isinstance(payload, dict) and payload.get("id") == normalized:
            return file_path

    raise TerminalSessionError(f"codex session file not found: {normalized}")


def normalize_text(value: Any) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


def extract_content_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""

    parts: list[str] = []
    image_tag_only = re.compile(r"^</?image\b[^>]*>$", re.IGNORECASE)
    for item in content:
        if not isinstance(item, dict):
            continue
        item_type = item.get("type")
        if item_type in {"input_text", "output_text", "text"}:
            text = normalize_text(item.get("text"))
            if text and not image_tag_only.match(text):
                parts.append(text)
            continue
        if item_type == "input_image":
            image_url = normalize_text(item.get("image_url")) or normalize_text(item.get("imageUrl"))
            if image_url:
                parts.append(f"[image: {image_url}]")
    return "\n\n".join(parts).strip()


def extract_reasoning_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return "\n\n".join(filter(None, (extract_reasoning_text(item) for item in value))).strip()
    if not isinstance(value, dict):
        return ""
    for key in ("text", "summary", "content"):
        text = extract_reasoning_text(value.get(key))
        if text:
            return text
    if normalize_text(value.get("encrypted_content")):
        return "Encrypted reasoning captured in the session log"
    return ""


def extract_tool_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if value is None:
        return ""
    try:
        return json.dumps(value, ensure_ascii=False, indent=2)
    except TypeError:
        return str(value)


def payload_type(record: dict[str, Any]) -> tuple[dict[str, Any], str]:
    payload = record.get("payload")
    if not isinstance(payload, dict):
        return {}, ""
    value = payload.get("type")
    return payload, value if isinstance(value, str) else ""


def content_for_record(record: dict[str, Any]) -> str:
    payload, kind = payload_type(record)
    if not payload:
        return ""

    if record.get("type") == "event_msg":
        if kind == "turn_aborted":
            reason = normalize_text(payload.get("reason"))
            return f"Turn aborted ({reason})." if reason else "Turn aborted."
        if kind == "error":
            return normalize_text(payload.get("message"))
        if kind == "context_compacted" or kind == "contextCompacted":
            return "Context compacted"
        if kind == "task_started":
            return "Task started"
        if kind == "task_complete":
            return normalize_text(payload.get("last_agent_message")) or "Task complete"
        if kind == "agent_reasoning":
            return normalize_text(payload.get("text"))
        if kind == "token_count":
            return "Token count update"
        return ""

    if record.get("type") != "response_item":
        return ""

    if kind == "message":
        return extract_content_text(payload.get("content"))
    if kind == "reasoning":
        return extract_reasoning_text(payload)
    if kind in {"function_call", "custom_tool_call", "web_search_call"}:
        name = normalize_text(payload.get("name")) or kind
        arguments = payload.get("arguments", payload.get("input"))
        argument_text = extract_tool_text(arguments)
        return f"{name}\n{argument_text}".strip()
    if kind in {"function_call_output", "custom_tool_call_output"}:
        return extract_tool_text(payload.get("output"))
    return ""


def payload_candidate_ids(record: dict[str, Any]) -> Iterable[str]:
    payload, _kind = payload_type(record)
    for value in (
        record.get("uuid"),
        record.get("id"),
        payload.get("id"),
        payload.get("uuid"),
        payload.get("call_id"),
        payload.get("callId"),
    ):
        text = normalize_text(value)
        if text:
            yield text


def iter_conversation_message_contents(session_file: pathlib.Path) -> Iterable[ConversationMessageContent]:
    message_count = 0
    pending_tool_calls: set[str] = set()

    for item in load_jsonl_records(session_file):
        record = item.record
        payload, kind = payload_type(record)
        if not payload:
            continue

        def make_content(key_kind: str, text: str) -> ConversationMessageContent:
            return ConversationMessageContent(
                key=f"{item.offset}:{key_kind}:{message_count}",
                text=text,
                session_file=session_file,
                line_number=item.line_number,
                offset=item.offset,
            )

        if record.get("type") == "event_msg":
            if kind == "turn_aborted":
                text = content_for_record(record)
                yield make_content("turn-aborted-event", text)
                message_count += 1
                continue
            if kind == "error":
                text = content_for_record(record)
                if text:
                    yield make_content("system-error", text)
                    message_count += 1
                continue
            if kind == "token_count":
                yield make_content("token-limit-notice", content_for_record(record))
                message_count += 1
                continue
            if kind == "context_compacted" or kind == "contextCompacted":
                yield make_content("context-compacted", content_for_record(record))
                message_count += 1
                continue
            if kind == "task_started":
                yield make_content("task-started", content_for_record(record))
                message_count += 1
                continue
            if kind == "task_complete":
                yield make_content("task-complete", content_for_record(record))
                message_count += 1
                continue
            if kind == "agent_reasoning":
                text = content_for_record(record)
                if text:
                    yield make_content("agent-reasoning", text)
                    message_count += 1
                continue
            continue

        if record.get("type") != "response_item":
            continue

        if kind == "message":
            text = content_for_record(record)
            role = payload.get("role")
            if not text or role not in {"user", "assistant"}:
                continue
            if role == "user" and re.match(r"^\s*<turn_aborted>\s*[\s\S]*?</turn_aborted>\s*$", text, re.IGNORECASE):
                yield make_content("turn-aborted-message", text)
            else:
                yield make_content("message", text)
            message_count += 1
            continue

        if kind == "reasoning":
            text = content_for_record(record)
            if text:
                yield make_content("reasoning", text)
                message_count += 1
            continue

        if kind in {"function_call", "custom_tool_call", "web_search_call"}:
            call_id = normalize_text(payload.get("call_id")) or f"unknown-call-{item.offset}"
            pending_tool_calls.add(call_id)
            yield make_content("tool", content_for_record(record))
            message_count += 1
            if kind == "web_search_call" and payload.get("status") is not None:
                pending_tool_calls.discard(call_id)
            continue

        if kind in {"function_call_output", "custom_tool_call_output"}:
            call_id = normalize_text(payload.get("call_id")) or f"unknown-call-{item.offset}"
            if call_id in pending_tool_calls:
                pending_tool_calls.discard(call_id)
                continue
            yield make_content("tool-result", content_for_record(record))
            message_count += 1
            continue


def find_conversation_message_content(
    session_id: str,
    message_key: str,
    codex_home: pathlib.Path,
) -> ConversationMessageContent:
    session_file = resolve_session_file(session_id, codex_home)
    normalized_key = message_key.strip()
    if not normalized_key:
        raise TerminalSessionError("message key is required")

    offset_match = re.match(r"^(\d+):[^:]+:\d+$", normalized_key)
    if offset_match:
        target_offset = int(offset_match.group(1))
        for item in load_jsonl_records(session_file):
            if item.offset == target_offset:
                return ConversationMessageContent(
                    key=normalized_key,
                    text=content_for_record(item.record),
                    session_file=session_file,
                    line_number=item.line_number,
                    offset=item.offset,
                )

    for item in iter_conversation_message_contents(session_file):
        if item.key == normalized_key:
            return item

    for item in load_jsonl_records(session_file):
        if normalized_key in set(payload_candidate_ids(item.record)):
            return ConversationMessageContent(
                key=normalized_key,
                text=content_for_record(item.record),
                session_file=session_file,
                line_number=item.line_number,
                offset=item.offset,
            )

    raise TerminalSessionError(f"codex session message not found: {session_id} {message_key}")


def line_range_to_text(text: str, start: int | None, end: int | None) -> str:
    if start is None and end is None:
        return text

    lines = text.splitlines()
    if not lines:
        return ""
    start_index = max((start or 1) - 1, 0)
    end_index = min(end if end is not None else len(lines), len(lines))
    if end_index < start_index:
        return ""
    return "\n".join(lines[start_index:end_index])
