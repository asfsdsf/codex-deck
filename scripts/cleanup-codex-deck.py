#!/usr/bin/env python3
"""Delete codex-deck worktrees and branches in a safe, repeatable way."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Any


FLOW_BRANCH_RE = re.compile(r"^flow/[^/]+/[^/]+$")


@dataclass
class WorktreeEntry:
    path: pathlib.Path
    branch: str


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, text=True, capture_output=True, check=False)


def resolve_repo_root(path: str) -> pathlib.Path:
    probe = pathlib.Path(path).expanduser().resolve()
    result = run(["git", "-C", str(probe), "rev-parse", "--show-toplevel"])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "not a git repository")
    return pathlib.Path(result.stdout.strip()).resolve()


def load_json(path: pathlib.Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def parse_worktrees(repo_root: pathlib.Path) -> list[WorktreeEntry]:
    result = run(["git", "-C", str(repo_root), "worktree", "list", "--porcelain"])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "failed to list worktrees")

    entries: list[WorktreeEntry] = []
    path: pathlib.Path | None = None
    branch = ""
    for line in result.stdout.splitlines():
        if not line.strip():
            if path is not None:
                entries.append(WorktreeEntry(path=path, branch=branch))
            path = None
            branch = ""
            continue
        if line.startswith("worktree "):
            path = pathlib.Path(line.removeprefix("worktree ").strip()).resolve()
        elif line.startswith("branch refs/heads/"):
            branch = line.removeprefix("branch refs/heads/").strip()
    if path is not None:
        entries.append(WorktreeEntry(path=path, branch=branch))
    return entries


def is_under(path: pathlib.Path, parent: pathlib.Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def read_cmdline(pid: int) -> str:
    cmdline_path = pathlib.Path("/proc") / str(pid) / "cmdline"
    try:
        raw = cmdline_path.read_bytes()
    except Exception:
        return ""
    parts = [item.decode("utf-8", errors="replace") for item in raw.split(b"\x00") if item]
    return " ".join(parts)


def process_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def stop_pid(
    pid: int,
    name: str,
    expected_tokens: list[str],
    *,
    dry_run: bool,
    force_pids: bool,
    failures: list[str],
) -> None:
    if not process_is_alive(pid):
        print(f"[skip] {name} pid {pid} is not running")
        return

    cmdline = read_cmdline(pid)
    if expected_tokens and not all(token in cmdline for token in expected_tokens):
        msg = f"{name} pid {pid} command mismatch: {cmdline or '(unavailable)'}"
        if force_pids:
            print(f"[warn] {msg}; continuing because --force-pids was provided")
        else:
            print(f"[warn] {msg}; skipping kill (use --force-pids to override)")
            return

    if dry_run:
        print(f"[dry-run] would terminate {name} pid {pid}")
        return

    print(f"[apply] terminating {name} pid {pid}")
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError as exc:
        failures.append(f"failed to send SIGTERM to {name} pid {pid}: {exc}")
        return

    deadline = time.time() + 5.0
    while time.time() < deadline:
        if not process_is_alive(pid):
            print(f"[apply] {name} pid {pid} exited")
            return
        time.sleep(0.2)

    print(f"[warn] {name} pid {pid} still running after SIGTERM; sending SIGKILL")
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError as exc:
        failures.append(f"failed to send SIGKILL to {name} pid {pid}: {exc}")
        return
    if process_is_alive(pid):
        failures.append(f"{name} pid {pid} is still alive after SIGKILL")
    else:
        print(f"[apply] {name} pid {pid} killed")


def parse_int(value: Any) -> int | None:
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, str) and value.strip().isdigit():
        out = int(value.strip())
        return out if out > 0 else None
    return None


def global_daemon_state_path() -> pathlib.Path:
    override = os.environ.get("CODEX_DECK_DAEMON_HOME", "").strip()
    if override:
        return pathlib.Path(override).expanduser().resolve() / "state.json"
    return (
        pathlib.Path.home()
        / ".codex"
        / "codex-deck"
        / "workflows"
        / "daemon-state"
        / "state.json"
    ).resolve()


def collect_workflow_inputs(flow_dir: pathlib.Path) -> tuple[set[pathlib.Path], set[str], set[pathlib.Path], set[int], set[int]]:
    workflow_files: set[pathlib.Path] = set()
    branches: set[str] = set()
    worktrees: set[pathlib.Path] = set()
    daemon_pids: set[int] = set()
    runner_pids: set[int] = set()

    for wf_path in sorted(flow_dir.glob("*.json")):
        workflow_files.add(wf_path.resolve())
        data = load_json(wf_path)
        if not data:
            continue
        if isinstance(data.get("workflow"), dict):
            wf_id = str(data["workflow"].get("id") or "").strip()
            if wf_id:
                branches.add(f"flow/{wf_id}/integration")

        main = data.get("mainAgent")
        if isinstance(main, dict):
            controller = main.get("controller")
            if isinstance(controller, dict):
                pid = parse_int(controller.get("daemonPid"))
                if pid:
                    daemon_pids.add(pid)

        for task in data.get("tasks", []):
            if not isinstance(task, dict):
                continue
            branch = str(task.get("branchName") or "").strip()
            if branch:
                branches.add(branch)
            wt = str(task.get("worktreePath") or "").strip()
            if wt:
                worktrees.add(pathlib.Path(wt).expanduser().resolve())
            pid = parse_int(task.get("runnerPid"))
            if pid:
                runner_pids.add(pid)

    state_path = flow_dir / "daemon" / "state.json"
    state = load_json(state_path)
    if state:
        pid = parse_int(state.get("pid"))
        if pid:
            daemon_pids.add(pid)

    return workflow_files, branches, worktrees, daemon_pids, runner_pids


def local_branches(repo_root: pathlib.Path) -> set[str]:
    result = run(["git", "-C", str(repo_root), "for-each-ref", "--format=%(refname:short)", "refs/heads"])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "failed to list branches")
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def delete_worktree(repo_root: pathlib.Path, wt: pathlib.Path, *, dry_run: bool, failures: list[str]) -> None:
    if dry_run:
        print(f"[dry-run] would remove worktree {wt}")
        return

    def try_remove() -> bool:
        result = run(["git", "-C", str(repo_root), "worktree", "remove", "--force", str(wt)])
        return result.returncode == 0

    print(f"[apply] removing worktree {wt}")
    if try_remove():
        return
    run(["git", "-C", str(repo_root), "worktree", "prune", "--expire", "now"])
    if try_remove():
        return
    if wt.exists():
        try:
            shutil.rmtree(wt)
            print(f"[apply] removed directory {wt} after git worktree remove failed")
        except OSError as exc:
            failures.append(f"failed to remove worktree directory {wt}: {exc}")
            return
    run(["git", "-C", str(repo_root), "worktree", "prune", "--expire", "now"])


def delete_branch(repo_root: pathlib.Path, branch: str, *, dry_run: bool, failures: list[str]) -> None:
    if dry_run:
        print(f"[dry-run] would delete branch {branch}")
        return
    result = run(["git", "-C", str(repo_root), "branch", "-D", branch])
    if result.returncode == 0:
        print(f"[apply] deleted branch {branch}")
    else:
        failures.append(f"failed to delete branch {branch}: {result.stderr.strip() or result.stdout.strip()}")


def remove_path(path: pathlib.Path, *, dry_run: bool, failures: list[str]) -> None:
    if not path.exists():
        return
    if dry_run:
        print(f"[dry-run] would delete {path}")
        return
    try:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()
        print(f"[apply] deleted {path}")
    except OSError as exc:
        failures.append(f"failed to delete {path}: {exc}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Clean up codex-deck generated worktrees and branches safely.",
    )
    parser.add_argument("--repo", default=".", help="Path inside the target git repository (default: current directory).")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Perform destructive cleanup. Without this flag the script runs in dry-run mode.",
    )
    parser.add_argument(
        "--force-pids",
        action="store_true",
        help="Kill discovered daemon/runner PIDs even when command line validation fails.",
    )
    parser.add_argument(
        "--delete-flow-dir",
        action="store_true",
        help="Delete the entire .codex-deck directory after branch/worktree cleanup.",
    )
    parser.add_argument(
        "--stop-global-daemon",
        action="store_true",
        help="Also stop the shared global codex-deck-flow daemon for the configured daemon home.",
    )
    parser.add_argument(
        "--keep-workflow-files",
        action="store_true",
        help="Keep .codex-deck/*.json workflow files (default behavior is to delete them).",
    )
    args = parser.parse_args()

    dry_run = not args.apply
    failures: list[str] = []

    try:
        repo_root = resolve_repo_root(args.repo)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    flow_dir = (repo_root / ".codex-deck").resolve()
    flow_worktrees_dir = (flow_dir / "worktrees").resolve()

    print(f"Repo root: {repo_root}")
    print(f"Mode: {'dry-run' if dry_run else 'apply'}")

    if not flow_dir.exists():
        print("No .codex-deck directory found. Nothing to clean.")
        return 0

    workflow_files, workflow_branches, workflow_worktrees, daemon_pids, runner_pids = collect_workflow_inputs(flow_dir)
    if args.stop_global_daemon:
        global_state = load_json(global_daemon_state_path())
        if global_state:
            pid = parse_int(global_state.get("pid"))
            if pid:
                daemon_pids.add(pid)
    try:
        worktree_entries = parse_worktrees(repo_root)
        all_local_branches = local_branches(repo_root)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    registered_flow_worktrees = {entry.path for entry in worktree_entries if is_under(entry.path, flow_worktrees_dir)}
    discovered_worktrees = set(workflow_worktrees) | registered_flow_worktrees
    if flow_worktrees_dir.exists():
        for child in flow_worktrees_dir.iterdir():
            discovered_worktrees.add(child.resolve())

    flow_pattern_branches = {branch for branch in all_local_branches if FLOW_BRANCH_RE.match(branch)}
    discovered_branches = set(workflow_branches) | flow_pattern_branches

    print(
        "Discovered: "
        f"{len(workflow_files)} workflow files, "
        f"{len(discovered_worktrees)} worktree paths, "
        f"{len(discovered_branches)} candidate branches, "
        f"{len(daemon_pids)} daemon pids, "
        f"{len(runner_pids)} runner pids"
    )

    stop_daemon_pids = sorted(daemon_pids) if args.stop_global_daemon else []
    skipped_daemon_pids = sorted(daemon_pids - set(stop_daemon_pids)) if daemon_pids else []
    for pid in skipped_daemon_pids:
        print(f"[skip] leaving shared/global daemon pid {pid} running (use --stop-global-daemon to stop it)")

    for pid in stop_daemon_pids:
        stop_pid(
            pid,
            "daemon",
            ["codex-deck", "daemon.py"],
            dry_run=dry_run,
            force_pids=args.force_pids,
            failures=failures,
        )

    for pid in sorted(runner_pids):
        stop_pid(
            pid,
            "task-runner",
            ["codex-deck", "task_runner.py"],
            dry_run=dry_run,
            force_pids=args.force_pids,
            failures=failures,
        )

    if not dry_run:
        run(["git", "-C", str(repo_root), "worktree", "prune", "--expire", "now"])

    for wt in sorted(discovered_worktrees):
        if not is_under(wt, flow_worktrees_dir):
            print(f"[warn] skipping non-codex-deck worktree path: {wt}")
            continue
        delete_worktree(repo_root, wt, dry_run=dry_run, failures=failures)

    if not dry_run:
        run(["git", "-C", str(repo_root), "worktree", "prune", "--expire", "now"])

    current_worktrees = parse_worktrees(repo_root)
    in_use_branches = {entry.branch for entry in current_worktrees if entry.branch}
    deletable_branches = sorted(discovered_branches & all_local_branches - in_use_branches)
    skipped_in_use = sorted(discovered_branches & in_use_branches)

    if skipped_in_use:
        for branch in skipped_in_use:
            print(f"[skip] branch is checked out in a worktree: {branch}")

    for branch in deletable_branches:
        delete_branch(repo_root, branch, dry_run=dry_run, failures=failures)

    if args.delete_flow_dir:
        remove_path(flow_dir, dry_run=dry_run, failures=failures)
    else:
        workflow_lock_paths: set[pathlib.Path] = set()
        if not args.keep_workflow_files:
            for workflow_file in sorted(workflow_files):
                remove_path(workflow_file, dry_run=dry_run, failures=failures)
                lock_path = workflow_file.with_suffix(".lock")
                workflow_lock_paths.add(lock_path.resolve())
                remove_path(lock_path, dry_run=dry_run, failures=failures)
        remove_path(flow_worktrees_dir, dry_run=dry_run, failures=failures)
        if args.stop_global_daemon:
            remove_path(flow_dir / "daemon", dry_run=dry_run, failures=failures)
        else:
            print("[skip] keeping .codex-deck/daemon artifacts by default because daemon state is shared globally")
        remove_path(flow_dir / "logs", dry_run=dry_run, failures=failures)
        for lock_file in sorted(flow_dir.glob("*.lock")):
            if lock_file.resolve() in workflow_lock_paths:
                continue
            remove_path(lock_file, dry_run=dry_run, failures=failures)
        if flow_dir.exists():
            try:
                next(flow_dir.iterdir())
            except StopIteration:
                remove_path(flow_dir, dry_run=dry_run, failures=failures)

    if failures:
        print("\nCleanup finished with errors:")
        for item in failures:
            print(f"- {item}")
        return 1

    print("\nCleanup finished successfully.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
