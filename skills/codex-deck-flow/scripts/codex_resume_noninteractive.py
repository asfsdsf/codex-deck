#!/usr/bin/env python3
"""Send a prompt to an existing Codex session in non-interactive mode."""

from __future__ import annotations

import argparse
import codecs
import json
import os
import queue
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any

DEFAULT_REQUEST_TIMEOUT_SEC = 30.0
DEFAULT_POLL_MS = 1_000
DEFAULT_TIMEOUT_MS = 300_000

TURN_STATUSES = {"inProgress", "completed", "failed", "interrupted"}
TERMINAL_TURN_STATUSES = {"completed", "failed", "interrupted"}
VALID_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh")
VALID_SERVICE_TIERS = ("fast", "flex")
DEFAULT_CODEX_SANDBOX_MODE = "danger-full-access"
FIXED_SANDBOX_POLICY: dict[str, str] = {"type": "dangerFullAccess"}
RETRY_AFTER_RESUME_SUBSTRINGS = (
    "thread not found",
    "thread not loaded",
    "not loaded",
    "unknown thread",
    "no rollout found for thread id",
    "not materialized yet",
)


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.data = data


class TransportError(Exception):
    pass


class AppServerStdoutMessageParser:
    """Incrementally extracts JSON object messages from app-server stdout."""

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")()
        self._buffer = ""
        self._scan_index = 0
        self._object_start = -1
        self._depth = 0
        self._in_string = False
        self._escape_next = False

    def push(self, chunk: bytes) -> list[dict[str, Any]]:
        text = self._decoder.decode(chunk, final=False)
        return self._push_text(text)

    def finish(self) -> list[dict[str, Any]]:
        trailing = self._decoder.decode(b"", final=True)
        messages = self._push_text(trailing) if trailing else []
        self.reset()
        return messages

    def reset(self) -> None:
        self._buffer = ""
        self._scan_index = 0
        self._object_start = -1
        self._depth = 0
        self._in_string = False
        self._escape_next = False

    def _push_text(self, text: str) -> list[dict[str, Any]]:
        if not text:
            return []

        self._buffer += text
        messages: list[dict[str, Any]] = []

        while self._scan_index < len(self._buffer):
            ch = self._buffer[self._scan_index]

            if self._object_start == -1:
                if ch == "{":
                    self._object_start = self._scan_index
                    self._depth = 1
                    self._in_string = False
                    self._escape_next = False
                self._scan_index += 1
                continue

            if self._in_string:
                if self._escape_next:
                    self._escape_next = False
                elif ch == "\\":
                    self._escape_next = True
                elif ch == '"':
                    self._in_string = False
                self._scan_index += 1
                continue

            if ch == '"':
                self._in_string = True
                self._scan_index += 1
                continue

            if ch == "{":
                self._depth += 1
                self._scan_index += 1
                continue

            if ch == "}":
                self._depth -= 1
                self._scan_index += 1
                if self._depth == 0:
                    raw = self._buffer[self._object_start : self._scan_index]
                    parsed = self._parse_message(raw)
                    if parsed is not None:
                        messages.append(parsed)
                    self._buffer = self._buffer[self._scan_index :]
                    self._scan_index = 0
                    self._object_start = -1
                    self._depth = 0
                    self._in_string = False
                    self._escape_next = False
                continue

            self._scan_index += 1

        if self._object_start == -1 and self._buffer:
            self._buffer = ""
            self._scan_index = 0

        return messages

    @staticmethod
    def _parse_message(text: str) -> dict[str, Any] | None:
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None


@dataclass
class ThreadState:
    thread_id: str
    active_turn_id: str | None
    is_generating: bool
    requested_turn_id: str | None
    requested_turn_status: str | None


def should_retry_after_resume(error: Exception) -> bool:
    if not isinstance(error, RpcError):
        return False
    lowered = str(error).lower()
    return any(fragment in lowered for fragment in RETRY_AFTER_RESUME_SUBSTRINGS)


def to_turn_status(value: Any) -> str | None:
    return value if isinstance(value, str) and value in TURN_STATUSES else None


def extract_turns_from_thread_read(result: Any) -> list[dict[str, Any]]:
    if not isinstance(result, dict):
        return []
    thread_value = result.get("thread")
    if not isinstance(thread_value, dict):
        return []
    turns = thread_value.get("turns")
    return turns if isinstance(turns, list) else []


def extract_thread_runtime_status(result: Any) -> str:
    if not isinstance(result, dict):
        return "unknown"
    thread_value = result.get("thread")
    if not isinstance(thread_value, dict):
        return "unknown"
    status = thread_value.get("status")
    if not isinstance(status, dict):
        return "unknown"
    status_type = status.get("type")
    if status_type in {"notLoaded", "idle", "systemError", "active"}:
        return str(status_type)
    return "unknown"


def extract_turn_id_from_turn_start(result: Any) -> str | None:
    if not isinstance(result, dict):
        return None
    turn = result.get("turn")
    if not isinstance(turn, dict):
        return None
    turn_id = turn.get("id")
    if not isinstance(turn_id, str):
        return None
    normalized = turn_id.strip()
    return normalized or None


class CodexAppServerClient:
    def __init__(
        self,
        executable_path: str,
        cwd: str | None = None,
        request_timeout_sec: float = DEFAULT_REQUEST_TIMEOUT_SEC,
    ) -> None:
        self._executable_path = executable_path
        self._cwd = cwd
        self._request_timeout_sec = request_timeout_sec
        self._process: subprocess.Popen[bytes] | None = None
        self._initialized = False
        self._request_id = 0
        self._messages: queue.Queue[dict[str, Any] | object] = queue.Queue()
        self._stdout_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self._stdout_closed_sentinel = object()

    def close(self) -> None:
        process = self._process
        self._process = None
        self._initialized = False

        if process is None:
            return

        try:
            if process.stdin:
                process.stdin.close()
        except OSError:
            pass

        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)

    def request(self, method: str, params: dict[str, Any]) -> Any:
        self._ensure_started()
        if method != "initialize":
            self._ensure_initialized()
        return self._request_raw(method, params, self._request_timeout_sec)

    def send_message(
        self,
        thread_id: str,
        text: str,
        cwd: str | None = None,
        model: str | None = None,
        effort: str | None = None,
        service_tier: str | None = None,
    ) -> str | None:
        normalized_thread_id = thread_id.strip()
        if not normalized_thread_id:
            raise ValueError("thread id is required")

        normalized_text = text.strip()
        if not normalized_text:
            raise ValueError("prompt is required")

        params: dict[str, Any] = {
            "threadId": normalized_thread_id,
            "input": [{"type": "text", "text": normalized_text}],
            "attachments": [],
        }
        if cwd:
            params["cwd"] = cwd.strip()
        if model:
            params["model"] = model.strip()
        if effort:
            params["effort"] = effort
        if service_tier is not None:
            params["serviceTier"] = service_tier
        params["sandboxPolicy"] = FIXED_SANDBOX_POLICY

        try:
            result = self.request("turn/start", params)
        except Exception as error:
            if not should_retry_after_resume(error):
                raise
            self.resume_thread(normalized_thread_id)
            result = self.request("turn/start", params)

        return extract_turn_id_from_turn_start(result)

    def resume_thread(self, thread_id: str) -> None:
        self.request(
            "thread/resume",
            {"threadId": thread_id, "persistExtendedHistory": True},
        )

    def read_thread(self, thread_id: str, include_turns: bool) -> Any:
        payload = {"threadId": thread_id, "includeTurns": include_turns}
        try:
            return self.request("thread/read", payload)
        except Exception as error:
            if not should_retry_after_resume(error):
                raise
            self.resume_thread(thread_id)
            return self.request("thread/read", payload)

    def get_thread_state(
        self, thread_id: str, requested_turn_id: str | None = None
    ) -> ThreadState:
        normalized_thread_id = thread_id.strip()
        if not normalized_thread_id:
            raise ValueError("thread id is required")

        normalized_requested_turn = (
            requested_turn_id.strip() if isinstance(requested_turn_id, str) else None
        )
        if normalized_requested_turn == "":
            normalized_requested_turn = None

        result = self.read_thread(normalized_thread_id, include_turns=True)
        turns = extract_turns_from_thread_read(result)

        active_turn_id: str | None = None
        requested_turn_status: str | None = None

        for turn in reversed(turns):
            if not isinstance(turn, dict):
                continue
            turn_id_raw = turn.get("id")
            turn_id = turn_id_raw.strip() if isinstance(turn_id_raw, str) else ""
            turn_status = to_turn_status(turn.get("status"))

            if (
                normalized_requested_turn
                and turn_id == normalized_requested_turn
                and turn_status is not None
            ):
                requested_turn_status = turn_status

            if active_turn_id is None and turn_status == "inProgress" and turn_id:
                active_turn_id = turn_id

        thread_runtime_status = extract_thread_runtime_status(result)
        is_generating = bool(active_turn_id) or thread_runtime_status == "active"

        return ThreadState(
            thread_id=normalized_thread_id,
            active_turn_id=active_turn_id,
            is_generating=is_generating,
            requested_turn_id=normalized_requested_turn,
            requested_turn_status=requested_turn_status,
        )

    def _ensure_started(self) -> None:
        if self._process is not None:
            return

        env = os.environ.copy()
        env["CODEX_USER_AGENT"] = env.get(
            "CODEX_USER_AGENT", "codex-resume-noninteractive/0.1.0"
        )
        env["CODEX_CLIENT_ID"] = env.get(
            "CODEX_CLIENT_ID", f"codex-resume-{uuid.uuid4()}"
        )

        try:
            process = subprocess.Popen(
                [
                    self._executable_path,
                    "--sandbox",
                    DEFAULT_CODEX_SANDBOX_MODE,
                    "app-server",
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=self._cwd,
                env=env,
            )
        except OSError as error:
            raise TransportError(f"failed to start codex app-server: {error}") from error

        self._process = process

        self._stdout_thread = threading.Thread(
            target=self._stdout_loop,
            name="codex-app-server-stdout",
            daemon=True,
        )
        self._stderr_thread = threading.Thread(
            target=self._stderr_loop,
            name="codex-app-server-stderr",
            daemon=True,
        )
        self._stdout_thread.start()
        self._stderr_thread.start()

    def _ensure_initialized(self) -> None:
        if self._initialized:
            return

        result = self._request_raw(
            "initialize",
            {
                "clientInfo": {
                    "name": "codex-deck",
                    "version": "0.2.4",
                },
                "capabilities": {
                    "experimentalApi": True,
                },
            },
            self._request_timeout_sec,
        )
        if not isinstance(result, dict):
            raise TransportError("invalid initialize response from codex app-server")
        self._initialized = True

    def _request_raw(self, method: str, params: dict[str, Any], timeout_sec: float) -> Any:
        process = self._process
        if process is None or process.stdin is None:
            raise TransportError("app-server failed to start")

        self._request_id += 1
        request_id = self._request_id
        payload = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        }

        try:
            wire = f"{json.dumps(payload, ensure_ascii=False)}\n".encode("utf-8")
            process.stdin.write(wire)
            process.stdin.flush()
        except OSError as error:
            raise TransportError(f"failed to write app-server request: {error}") from error

        deadline = time.monotonic() + timeout_sec
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TransportError(f"app-server request timed out: {method}")

            try:
                message = self._messages.get(timeout=remaining)
            except queue.Empty as error:
                raise TransportError(f"app-server request timed out: {method}") from error

            if message is self._stdout_closed_sentinel:
                raise TransportError("app-server closed")

            if not isinstance(message, dict):
                continue

            if message.get("id") != request_id:
                continue

            has_result = "result" in message
            has_error = "error" in message
            if not (has_result or has_error):
                continue

            if has_error:
                error_payload = message.get("error")
                if isinstance(error_payload, dict):
                    code = (
                        int(error_payload.get("code"))
                        if isinstance(error_payload.get("code"), int)
                        else -32000
                    )
                    message_text = error_payload.get("message")
                    error_message = (
                        str(message_text).strip()
                        if isinstance(message_text, str)
                        else "Unknown app-server error"
                    )
                    raise RpcError(code, error_message, error_payload.get("data"))
                raise RpcError(-32000, "Unknown app-server error")

            return message.get("result")

    def _stdout_loop(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            self._messages.put(self._stdout_closed_sentinel)
            return

        parser = AppServerStdoutMessageParser()
        stdout_fd = process.stdout.fileno()
        try:
            while True:
                chunk = os.read(stdout_fd, 4096)
                if not chunk:
                    break
                for parsed in parser.push(chunk):
                    self._messages.put(parsed)
        finally:
            for parsed in parser.finish():
                self._messages.put(parsed)
            self._messages.put(self._stdout_closed_sentinel)

    def _stderr_loop(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return

        while True:
            line = process.stderr.readline()
            if not line:
                return
            text = line.decode("utf-8", errors="replace").strip()
            if text:
                print(f"[codex app-server] {text}", file=sys.stderr)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Send a prompt to an existing Codex session in non-interactive mode."
    )
    parser.add_argument("session_id", nargs="?", help="Session (thread) id to resume")
    parser.add_argument(
        "prompt_parts",
        nargs="*",
        help="Prompt text if --prompt is omitted (quote multi-word prompt).",
    )
    parser.add_argument("-s", "--session", dest="session_opt", help="Session id override")
    parser.add_argument("-p", "--prompt", dest="prompt_opt", help="Prompt override")
    parser.add_argument("--cwd", help="Optional cwd override")
    parser.add_argument("--model", help="Optional model override")
    parser.add_argument("--effort", choices=VALID_EFFORTS, help="Reasoning effort")
    parser.add_argument(
        "--service-tier", choices=VALID_SERVICE_TIERS, help="Service tier"
    )
    parser.add_argument(
        "--wait",
        dest="wait",
        action="store_true",
        default=True,
        help="Wait for completion (default)",
    )
    parser.add_argument(
        "--no-wait",
        dest="wait",
        action="store_false",
        help="Return after turn/start",
    )
    parser.add_argument(
        "--poll-ms",
        type=int,
        default=DEFAULT_POLL_MS,
        help=f"Polling interval while waiting (default: {DEFAULT_POLL_MS})",
    )
    parser.add_argument(
        "--timeout-ms",
        type=int,
        default=DEFAULT_TIMEOUT_MS,
        help=f"Wait timeout in ms; 0 disables timeout (default: {DEFAULT_TIMEOUT_MS})",
    )
    parser.add_argument("--json", action="store_true", help="Emit JSON output")
    return parser.parse_args(argv)


def resolve_prompt(prompt_opt: str | None, prompt_parts: list[str]) -> str:
    if prompt_opt is not None and prompt_opt.strip():
        return prompt_opt.strip()
    if prompt_parts:
        joined = " ".join(prompt_parts).strip()
        if joined:
            return joined
    if not sys.stdin.isatty():
        piped = sys.stdin.read().strip()
        if piped:
            return piped
    return ""


def wait_for_turn_completion(
    client: CodexAppServerClient,
    session_id: str,
    turn_id: str,
    poll_ms: int,
    timeout_ms: int,
) -> str | None:
    started = time.monotonic()
    while True:
        state = client.get_thread_state(session_id, turn_id)
        status = state.requested_turn_status
        if status in TERMINAL_TURN_STATUSES:
            return status

        if timeout_ms > 0 and (time.monotonic() - started) * 1000 >= timeout_ms:
            raise TimeoutError(
                f"timed out waiting for turn {turn_id} in session {session_id} to finish"
            )

        if poll_ms > 0:
            time.sleep(poll_ms / 1000.0)


def validate_non_negative(value: int, option: str) -> int:
    if value < 0:
        raise ValueError(f"{option} must be a non-negative integer")
    return value


def run(argv: list[str]) -> int:
    args = parse_args(argv)

    session_id = (args.session_opt or args.session_id or "").strip()
    if not session_id:
        raise ValueError("session id is required (pass positional <session-id> or --session)")

    poll_ms = validate_non_negative(args.poll_ms, "--poll-ms")
    timeout_ms = validate_non_negative(args.timeout_ms, "--timeout-ms")

    prompt = resolve_prompt(args.prompt_opt, args.prompt_parts)
    if not prompt:
        raise ValueError(
            "prompt is required (pass --prompt, positional prompt, or piped stdin)"
        )

    executable_path = (os.environ.get("CODEX_CLI_PATH") or "codex").strip() or "codex"
    client = CodexAppServerClient(executable_path=executable_path)

    try:
        turn_id = client.send_message(
            thread_id=session_id,
            text=prompt,
            cwd=args.cwd,
            model=args.model,
            effort=args.effort,
            service_tier=args.service_tier,
        )

        status: str | None = None
        if args.wait and turn_id:
            status = wait_for_turn_completion(
                client=client,
                session_id=session_id,
                turn_id=turn_id,
                poll_ms=poll_ms,
                timeout_ms=timeout_ms,
            )

        failed_status = bool(args.wait and status in {"failed", "interrupted"})

        if args.json:
            print(
                json.dumps(
                    {
                        "ok": not failed_status,
                        "sessionId": session_id,
                        "turnId": turn_id,
                        "waited": bool(args.wait),
                        "status": status,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        else:
            print(f"sessionId: {session_id}")
            print(f"turnId: {turn_id or '(unknown)'}")
            if args.wait:
                print(f"status: {status or '(pending or unknown)'}")
            else:
                print("status: started")

        return 1 if failed_status else 0
    finally:
        client.close()


def main() -> None:
    try:
        exit_code = run(sys.argv[1:])
    except Exception as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
