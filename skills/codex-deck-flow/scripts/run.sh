#!/usr/bin/env bash
set -euo pipefail

# This shell script is the stable, operator-facing command surface for codex-deck.
# It keeps the public skill API small and forwards almost all behavior into the
# Python runtime helpers in this directory.
#
# Important handoff: `trigger` is intentionally not a long-running command. It
# ensures the background daemon is running, sends a single enqueue-trigger
# control message, and exits so the daemon becomes the orchestration owner.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd -P)}"

print_cmd() {
  local has_codex=0
  local has_exec_or_resume=0
  local arg
  for arg in "$@"; do
    if [[ "$arg" == "codex" || "${arg##*/}" == "codex" ]]; then
      has_codex=1
    fi
    if [[ "$arg" == "exec" || "$arg" == "resume" ]]; then
      has_exec_or_resume=1
    fi
  done
  if [[ "$has_codex" -ne 1 || "$has_exec_or_resume" -ne 1 ]]; then
    return
  fi

  if [[ "${CODEX_DECK_RUNNER:-}" == "api" || ! -t 1 ]]; then
    printf '[codex-deck cli] exec:' >&2
    for arg in "$@"; do
      printf ' %q' "$arg" >&2
    done
    printf '\n' >&2
    return
  fi

  printf '[codex-deck cli] exec:'
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'
}

if [[ $# -lt 1 ]]; then
  cat <<'EOF'
Usage:
  run.sh create --title <title> --request <request> [--task-count N>=0] [--target-branch <branch>] [--json]
  run.sh trigger --workflow <path>
  run.sh daemon-start
  run.sh daemon-stop
  run.sh daemon-status
  run.sh stop-workflow-processes --workflow <path>
  run.sh daemon-send --workflow <path> --type <message-type> [--payload-json <json>]
  run.sh resolve-workflow --project-root <path> --workflow-id <id> [--codex-home <path>] [--json]
  run.sh validate --workflow <path> [--json]
  run.sh ready-tasks --workflow <path> [--json]
  run.sh launch-task --workflow <path> --task-id <id>
  run.sh reconcile --workflow <path>
  run.sh status --workflow <path>
  run.sh show --workflow <path>
  run.sh prompt --workflow <path> [--reason <reason>]
  run.sh merge --workflow <path> [--preview] [--apply]
  run.sh session-state --session-id <id> [--codex-home <path>]
  run.sh backfill-registry [--project-root <path>] [--codex-home <path>]

Recommended operator flows:
  Existing workflow by path: validate -> reconcile -> status
  Existing workflow bootstrap by project root + id: resolve-workflow -> validate -> reconcile -> status
  New workflow: create -> validate -> show/status -> user approval -> trigger
    If --target-branch is omitted, create uses the current checked-out branch in the project root and falls back to main only if git cannot resolve a named branch.
  Daemon mode: daemon-start -> trigger/daemon-send -> inspect later with status/show

Aliases:
  run.sh trigger -> daemon enqueue-trigger (fallback to workflow.py trigger-scheduler)
  run.sh prompt  -> workflow.py render-scheduler-prompt
EOF
  exit 1
fi

cmd="$1"
shift

case "$cmd" in
  create)
    print_cmd "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" create "$@"
    exec "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" create "$@"
    ;;
  trigger)
    print_cmd "$PYTHON_BIN" "$SCRIPT_DIR/daemon.py" start --project-root "$PROJECT_ROOT"
    "$PYTHON_BIN" "$SCRIPT_DIR/daemon.py" start --project-root "$PROJECT_ROOT" >/dev/null
    print_cmd "$PYTHON_BIN" "$SCRIPT_DIR/daemon_send.py" --type enqueue-trigger "$@"
    exec "$PYTHON_BIN" "$SCRIPT_DIR/daemon_send.py" --type enqueue-trigger "$@"
    ;;
  daemon-start)
    print_cmd "$PYTHON_BIN" "$SCRIPT_DIR/daemon.py" start --project-root "$PROJECT_ROOT"
    exec "$PYTHON_BIN" "$SCRIPT_DIR/daemon.py" start --project-root "$PROJECT_ROOT"
    ;;
  daemon-stop)
    print_cmd "$PYTHON_BIN" "$SCRIPT_DIR/daemon.py" stop --project-root "$PROJECT_ROOT"
    exec "$PYTHON_BIN" "$SCRIPT_DIR/daemon.py" stop --project-root "$PROJECT_ROOT"
    ;;
  daemon-status)
    print_cmd "$PYTHON_BIN" "$SCRIPT_DIR/daemon.py" status --project-root "$PROJECT_ROOT"
    exec "$PYTHON_BIN" "$SCRIPT_DIR/daemon.py" status --project-root "$PROJECT_ROOT"
    ;;
  daemon-send)
    print_cmd "$PYTHON_BIN" "$SCRIPT_DIR/daemon_send.py" "$@"
    exec "$PYTHON_BIN" "$SCRIPT_DIR/daemon_send.py" "$@"
    ;;
  stop-workflow-processes)
    print_cmd "$PYTHON_BIN" "$SCRIPT_DIR/daemon_send.py" --type stop-workflow-processes "$@"
    exec "$PYTHON_BIN" "$SCRIPT_DIR/daemon_send.py" --type stop-workflow-processes "$@"
    ;;
  resolve-workflow)
    print_cmd "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" resolve-workflow "$@"
    exec "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" resolve-workflow "$@"
    ;;
  validate)
    print_cmd "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" validate "$@"
    exec "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" validate "$@"
    ;;
  ready-tasks)
    print_cmd "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" ready-tasks "$@"
    exec "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" ready-tasks "$@"
    ;;
  launch-task)
    print_cmd "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" launch-task "$@"
    exec "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" launch-task "$@"
    ;;
  reconcile)
    print_cmd "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" reconcile "$@"
    exec "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" reconcile "$@"
    ;;
  status)
    print_cmd "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" status "$@"
    exec "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" status "$@"
    ;;
  show)
    print_cmd "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" show "$@"
    exec "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" show "$@"
    ;;
  prompt)
    print_cmd "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" render-scheduler-prompt "$@"
    exec "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" render-scheduler-prompt "$@"
    ;;
  merge)
    print_cmd "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" merge "$@"
    exec "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" merge "$@"
    ;;
  session-state)
    print_cmd "$PYTHON_BIN" "$SCRIPT_DIR/session_state.py" "$@"
    exec "$PYTHON_BIN" "$SCRIPT_DIR/session_state.py" "$@"
    ;;
  backfill-registry)
    print_cmd "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" backfill-registry "$@"
    exec "$PYTHON_BIN" "$SCRIPT_DIR/workflow.py" backfill-registry "$@"
    ;;
  *)
    echo "error: unknown command: $cmd" >&2
    exit 1
    ;;
esac
