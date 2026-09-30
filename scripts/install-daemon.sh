#!/usr/bin/env bash
set -euo pipefail

# Install and control a user-level codex-deck service. The service manager owns
# the Node process; this script is also the command installed for lifecycle
# operations so the same interface works on macOS and Linux.

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)"
USER_HOME="${HOME:?HOME must be set for a user daemon}"

COMMAND_NAME="codex-deck-daemon"
SERVICE_NAME="codex-deck"
LAUNCHD_LABEL="com.codex-deck.server"

PROJECT_ROOT="${CODEX_DECK_DAEMON_PROJECT_ROOT:-$REPO_ROOT}"
CONFIG_HOME="${CODEX_DECK_DAEMON_CONFIG_HOME:-${XDG_CONFIG_HOME:-$USER_HOME/.config}}"
STATE_DIR="${CODEX_DECK_DAEMON_STATE_DIR:-${XDG_STATE_HOME:-$USER_HOME/.local/state}/codex-deck}"
BIN_DIR="${CODEX_DECK_DAEMON_BIN_DIR:-${XDG_BIN_HOME:-$USER_HOME/.local/bin}}"
NODE_BIN="${CODEX_DECK_DAEMON_NODE_BIN:-}"
ENV_FILE="${CODEX_DECK_DAEMON_ENV_FILE:-}"
SERVICE_MANAGER="${CODEX_DECK_DAEMON_SERVICE_MANAGER:-auto}"

BUILD_BEFORE_INSTALL=1

die() {
  echo "codex-deck daemon: $*" >&2
  exit 1
}

info() {
  echo "codex-deck daemon: $*"
}

usage() {
  cat <<'EOF'
Usage:
  scripts/install-daemon.sh install [options]
  scripts/install-daemon.sh start
  scripts/install-daemon.sh stop
  scripts/install-daemon.sh restart
  scripts/install-daemon.sh status
  scripts/install-daemon.sh uninstall

Install options:
  --project-root <path>  Project containing package.json and dist/index.js
  --bin-dir <path>       Directory for codex-deck-daemon (default: ~/.local/bin)
  --env-file <path>      Optional shell environment file loaded by the service
  --node <path>          Node executable (default: node from PATH)
  --service-manager <m>  auto, systemd, or launchd
  --no-build             Skip `pnpm build` and use the existing dist/index.js
  -h, --help             Show this help

Lifecycle commands:
  codex-deck-daemon start|stop|restart|status
EOF
}

shell_quote() {
  local value="$1"
  value=${value//\'/\'\\\'\'}
  printf "'%s'" "$value"
}

xml_escape() {
  local value="$1"
  value=${value//&/&amp;}
  value=${value//</&lt;}
  value=${value//>/&gt;}
  value=${value//\"/&quot;}
  value=${value//\'/&apos;}
  printf '%s' "$value"
}

systemd_quote() {
  local value="$1"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//%/%%}
  printf '"%s"' "$value"
}

resolve_path() {
  local value="$1"
  if [[ "$value" = /* ]]; then
    printf '%s' "$value"
  else
    printf '%s/%s' "$(pwd -P)" "$value"
  fi
}

resolve_existing_file() {
  local value="$1"
  local resolved
  resolved="$(resolve_path "$value")"
  [[ -f "$resolved" ]] || die "file does not exist: $resolved"
  CDPATH= cd -- "$(dirname -- "$resolved")"
  printf '%s/%s' "$(pwd -P)" "$(basename -- "$resolved")"
}

resolve_existing_dir() {
  local value="$1"
  local resolved
  resolved="$(resolve_path "$value")"
  [[ -d "$resolved" ]] || die "directory does not exist: $resolved"
  CDPATH= cd -- "$resolved"
  pwd -P
}

detect_service_manager() {
  case "$SERVICE_MANAGER" in
    systemd|launchd)
      printf '%s' "$SERVICE_MANAGER"
      ;;
    auto)
      case "$(uname -s)" in
        Darwin)
          command -v launchctl >/dev/null 2>&1 || die "launchctl is required on macOS"
          printf 'launchd'
          ;;
        Linux)
          command -v systemctl >/dev/null 2>&1 || die "systemctl is required on Linux"
          printf 'systemd'
          ;;
        *)
          die "unsupported operating system; use macOS launchd or Linux systemd"
          ;;
      esac
      ;;
    *)
      die "unknown service manager '$SERVICE_MANAGER'; expected auto, systemd, or launchd"
      ;;
  esac
}

unit_path() {
  printf '%s/systemd/user/%s.service' "$CONFIG_HOME" "$SERVICE_NAME"
}

plist_path() {
  printf '%s/Library/LaunchAgents/%s.plist' "$USER_HOME" "$LAUNCHD_LABEL"
}

service_log_path() {
  printf '%s/server.log' "$STATE_DIR"
}

load_daemon_env_for_status() {
  if [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
  fi
}

config_dir_from_file() {
  local config_file="$1"
  [[ -f "$config_file" ]] || return 0
  sed -nE \
    '/^[[:space:]]*\[/q
     /^[[:space:]]*dir[[:space:]]*=[[:space:]]*"[^"]*"/ {
       s/^[[:space:]]*dir[[:space:]]*=[[:space:]]*"([^"]*)".*$/\1/
       p
       q
     }' "$config_file"
}

main_codex_home() {
  local default_home="${CODEX_HOME:-$USER_HOME/.codex}"
  local configured_dir configured_project_root runtime_project_root
  runtime_project_root="$PROJECT_ROOT"
  if [[ -f "$(active_project_root_path)" ]]; then
    IFS= read -r configured_project_root < "$(active_project_root_path)" || true
    if [[ "$configured_project_root" = /* && -f "$configured_project_root/dist/index.js" ]]; then
      runtime_project_root="$configured_project_root"
    fi
  fi
  configured_dir="$(config_dir_from_file "$runtime_project_root/config.toml")"
  if [[ -z "$configured_dir" ]]; then
    configured_dir="$(config_dir_from_file "$default_home/codex-deck/config.toml")"
  fi
  if [[ -n "$configured_dir" ]]; then
    if [[ "$configured_dir" = /* ]]; then
      printf '%s' "$configured_dir"
    else
      printf '%s/%s' "$runtime_project_root" "$configured_dir"
    fi
  elif [[ "$default_home" = "/" ]]; then
    printf '/'
  else
    printf '%s' "${default_home%/}"
  fi
}

main_codex_deck_config_path() {
  local codex_home
  codex_home="$(main_codex_home)"
  if [[ "$codex_home" = "/" ]]; then
    printf '/codex-deck/config.toml'
  else
    printf '%s/codex-deck/config.toml' "${codex_home%/}"
  fi
}

runner_path() {
  printf '%s/run-server.sh' "$STATE_DIR"
}

active_project_root_path() {
  printf '%s/active-project-root' "$STATE_DIR"
}

start_directory_path() {
  printf '%s/start-directory' "$STATE_DIR"
}

daemon_lifecycle_script_path() {
  printf '%s/install-daemon.sh' "$STATE_DIR"
}

install_lifecycle_script() {
  local source_path="$1"
  local destination
  destination="$(daemon_lifecycle_script_path)"
  if [[ "$source_path" != "$destination" ]]; then
    cp -f -- "$source_path" "$destination"
  fi
  chmod 700 "$destination"
}

refresh_lifecycle_script_from_active_project() {
  local active_root candidate_script configured_project_root
  active_root="$PROJECT_ROOT"
  if [[ -f "$(active_project_root_path)" ]]; then
    IFS= read -r configured_project_root < "$(active_project_root_path)" || true
    if [[ "$configured_project_root" = /* ]]; then
      active_root="$configured_project_root"
    fi
  fi
  candidate_script="$active_root/scripts/install-daemon.sh"
  if [[ -f "$candidate_script" ]]; then
    install_lifecycle_script "$candidate_script"
  fi
}

record_start_directory() {
  local current_directory temporary_path
  current_directory="$(pwd -P)"
  temporary_path="$(start_directory_path).$$.tmp"
  printf '%s\n' "$current_directory" > "$temporary_path"
  chmod 600 "$temporary_path"
  mv -f -- "$temporary_path" "$(start_directory_path)"
}

service_is_installed() {
  case "$SERVICE_MANAGER" in
    systemd)
      [[ -f "$(unit_path)" ]]
      ;;
    launchd)
      [[ -f "$(plist_path)" ]]
      ;;
    *)
      return 1
      ;;
  esac
}

require_installed() {
  service_is_installed || die "daemon is not installed; run scripts/install-daemon.sh install first"
}

systemd_start() {
  systemctl --user daemon-reload
  systemctl --user start "$SERVICE_NAME.service"
}

systemd_stop() {
  systemctl --user stop "$SERVICE_NAME.service"
}

systemd_restart() {
  systemctl --user daemon-reload
  systemctl --user restart "$SERVICE_NAME.service"
}

systemd_status() {
  printf '     Config: %s\n\n' "$(main_codex_deck_config_path)"
  systemctl --user status "$SERVICE_NAME.service" --no-pager --full || true
}

launchd_domain() {
  printf 'gui/%s' "$UID"
}

launchd_loaded() {
  launchctl print "$(launchd_domain)/$LAUNCHD_LABEL" >/dev/null 2>&1
}

launchd_start() {
  local domain
  domain="$(launchd_domain)"
  if ! launchd_loaded; then
    launchctl bootstrap "$domain" "$(plist_path)"
  fi
  launchctl kickstart "$domain/$LAUNCHD_LABEL"
}

launchd_stop() {
  local domain
  domain="$(launchd_domain)"
  if launchd_loaded; then
    launchctl bootout "$domain/$LAUNCHD_LABEL"
  fi
}

launchd_restart() {
  local domain
  domain="$(launchd_domain)"
  if launchd_loaded; then
    # bootout may return before launchd has fully removed the job. A following
    # start can then mistake the terminating job for a loaded one and leave the
    # service unloaded once bootout completes. kickstart -k is launchd's atomic
    # restart operation for an already loaded job.
    launchctl kickstart -k "$domain/$LAUNCHD_LABEL"
  else
    launchd_start
  fi
}

launchd_field() {
  local details="$1"
  local field="$2"
  awk -v field="$field" '
    {
      line = $0
      key = line
      sub(/[[:space:]]*=.*$/, "", key)
      sub(/^[[:space:]]+/, "", key)
      sub(/[[:space:]]+$/, "", key)
      if (key != field) {
        next
      }
      sub(/^[^=]*=[[:space:]]*/, "", line)
      print line
      exit
    }
  ' <<< "$details"
}

launchd_status() {
  if ! launchd_loaded; then
    printf '%s - Codex Deck web server\n' "$LAUNCHD_LABEL"
    printf '     Loaded: loaded (%s)\n' "$(plist_path)"
    printf '     Active: inactive (stopped; launchd job is not loaded)\n'
    printf '     Config: %s\n' "$(main_codex_deck_config_path)"
    printf '       Logs: %s\n' "$(service_log_path)"
    return 0
  fi

  local details
  if ! details="$(launchctl print "$(launchd_domain)/$LAUNCHD_LABEL" 2>/dev/null)"; then
    printf '%s - Codex Deck web server\n' "$LAUNCHD_LABEL"
    printf '     Loaded: loaded (%s)\n' "$(plist_path)"
    printf '     Active: unknown (launchd status unavailable)\n'
    printf '     Config: %s\n' "$(main_codex_deck_config_path)"
    printf '       Logs: %s\n' "$(service_log_path)"
    return 0
  fi

  local state pid service_path service_type working_directory program stdout_path stderr_path last_exit_code active
  state="$(launchd_field "$details" state)"
  pid="$(launchd_field "$details" pid)"
  service_path="$(launchd_field "$details" path)"
  service_type="$(launchd_field "$details" type)"
  working_directory="$(launchd_field "$details" 'working directory')"
  program="$(launchd_field "$details" program)"
  stdout_path="$(launchd_field "$details" 'stdout path')"
  stderr_path="$(launchd_field "$details" 'stderr path')"
  last_exit_code="$(launchd_field "$details" 'last exit code')"

  [[ -n "$service_path" ]] || service_path="$(plist_path)"
  [[ -n "$service_type" ]] || service_type="LaunchAgent"
  [[ -n "$working_directory" ]] || working_directory="$PROJECT_ROOT"
  [[ -n "$program" ]] || program="$(runner_path)"
  [[ -n "$stdout_path" ]] || stdout_path="$(service_log_path)"

  case "$state" in
    running)
      active='active (running)'
      ;;
    '')
      state='unknown'
      active='unknown'
      ;;
    *)
      active="active ($state)"
      ;;
  esac

  printf '%s - Codex Deck web server\n' "$LAUNCHD_LABEL"
  printf '     Loaded: loaded (%s)\n' "$service_path"
  printf '     Active: %s\n' "$active"
  printf '     Config: %s\n' "$(main_codex_deck_config_path)"
  if [[ -n "$pid" ]]; then
    printf '       PID: %s\n' "$pid"
  fi
  printf '      Type: %s\n' "$service_type"
  printf ' WorkingDir: %s\n' "$working_directory"
  printf '    Program: %s\n' "$program"
  if [[ "$stderr_path" = "$stdout_path" || -z "$stderr_path" ]]; then
    printf '       Logs: %s\n' "$stdout_path"
  else
    printf '       Logs: %s\n' "$stdout_path"
    printf '             %s\n' "$stderr_path"
  fi
  if [[ -n "$last_exit_code" ]]; then
    printf '  Last Exit: %s\n' "$last_exit_code"
  fi
}

service_start() {
  require_installed
  record_start_directory
  case "$SERVICE_MANAGER" in
    systemd) systemd_start ;;
    launchd) launchd_start ;;
  esac
  info "started"
}

service_stop() {
  require_installed
  case "$SERVICE_MANAGER" in
    systemd) systemd_stop ;;
    launchd) launchd_stop ;;
  esac
  info "stopped"
}

service_restart() {
  require_installed
  case "$SERVICE_MANAGER" in
    systemd) systemd_restart ;;
    launchd) launchd_restart ;;
  esac
  info "restarted"
}

service_restart_after_update() {
  require_installed
  refresh_lifecycle_script_from_active_project
  write_runner
  write_command_wrapper
  case "$SERVICE_MANAGER" in
    systemd)
      systemd_restart
      ;;
    launchd)
      if launchd_loaded; then
        launchctl kickstart -k "$(launchd_domain)/$LAUNCHD_LABEL"
      else
        launchd_start
      fi
      ;;
  esac
  info "restarted after update"
}

service_status() {
  require_installed
  load_daemon_env_for_status
  case "$SERVICE_MANAGER" in
    systemd) systemd_status ;;
    launchd) launchd_status ;;
  esac
}

write_runner() {
  local runner
  runner="$(runner_path)"
  {
    printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
    printf 'export NODE_ENV=production\n'
    printf 'export PATH=%s\n' "$(shell_quote "${PATH:-/usr/local/bin:/usr/bin:/bin}")"
    printf 'export CODEX_DECK_DAEMON_MANAGED=1\n'
    printf 'export CODEX_DECK_DAEMON_PROJECT_ROOT=%s\n' "$(shell_quote "$PROJECT_ROOT")"
    printf 'export CODEX_DECK_DAEMON_STATE_DIR=%s\n' "$(shell_quote "$STATE_DIR")"
    printf 'export CODEX_DECK_DAEMON_COMMAND_PATH=%s\n' "$(shell_quote "$BIN_DIR/$COMMAND_NAME")"
    printf 'ACTIVE_PROJECT_ROOT=%s\n' "$(shell_quote "$PROJECT_ROOT")"
    printf 'if [[ -f %s ]]; then\n' "$(shell_quote "$(active_project_root_path)")"
    printf '  IFS= read -r CONFIGURED_PROJECT_ROOT < %s || true\n' "$(shell_quote "$(active_project_root_path)")"
    printf '  if [[ "$CONFIGURED_PROJECT_ROOT" = /* && -f "$CONFIGURED_PROJECT_ROOT/dist/index.js" ]]; then\n'
    printf '    ACTIVE_PROJECT_ROOT="$CONFIGURED_PROJECT_ROOT"\n'
    printf '  fi\n'
    printf 'fi\n'
    printf 'export CODEX_DECK_DAEMON_ACTIVE_PROJECT_ROOT="$ACTIVE_PROJECT_ROOT"\n'
    printf 'export CODEX_DECK_DAEMON_START_DIRECTORY=%s\n' "$(shell_quote "$PROJECT_ROOT")"
    printf 'if [[ -f %s ]]; then\n' "$(shell_quote "$(start_directory_path)")"
    printf '  IFS= read -r CONFIGURED_START_DIRECTORY < %s || true\n' "$(shell_quote "$(start_directory_path)")"
    printf '  if [[ "$CONFIGURED_START_DIRECTORY" = /* && -d "$CONFIGURED_START_DIRECTORY" ]]; then\n'
    printf '    export CODEX_DECK_DAEMON_START_DIRECTORY="$CONFIGURED_START_DIRECTORY"\n'
    printf '  fi\n'
    printf 'fi\n'
    if [[ -n "$ENV_FILE" ]]; then
      printf 'if [[ -f %s ]]; then\n' "$(shell_quote "$ENV_FILE")"
      printf '  set -a\n  # shellcheck disable=SC1090\n  . %s\n  set +a\n' "$(shell_quote "$ENV_FILE")"
      printf 'fi\n'
    fi
    printf 'cd "$ACTIVE_PROJECT_ROOT"\n'
    printf 'exec %s "$ACTIVE_PROJECT_ROOT/dist/index.js" --no-open\n' \
      "$(shell_quote "$NODE_BIN")"
  } > "$runner"
  chmod 700 "$runner"
}

write_systemd_unit() {
  local unit
  unit="$(unit_path)"
  mkdir -p "$(dirname -- "$unit")"
  {
    printf '%s\n' '[Unit]' \
      'Description=Codex Deck web server' \
      'After=default.target' \
      '' '[Service]' \
      'Type=simple'
    printf 'WorkingDirectory=%s\n' "$PROJECT_ROOT"
    printf 'ExecStart=%s\n' "$(runner_path)"
    printf 'Environment=%s\n' "$(systemd_quote 'NODE_ENV=production')"
    printf 'Restart=on-failure\nRestartSec=3\n'
    printf 'StandardOutput=append:%s\n' "$(service_log_path)"
    printf 'StandardError=append:%s\n' "$(service_log_path)"
    printf '%s\n' '' '[Install]' 'WantedBy=default.target'
  } > "$unit"
  chmod 600 "$unit"
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME.service" >/dev/null
}

write_launchd_plist() {
  local plist
  plist="$(plist_path)"
  mkdir -p "$(dirname -- "$plist")"
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' '<plist version="1.0">' '<dict>'
    printf '  <key>Label</key><string>%s</string>\n' "$(xml_escape "$LAUNCHD_LABEL")"
    printf '  <key>ProgramArguments</key>\n  <array>\n    <string>%s</string>\n  </array>\n' "$(xml_escape "$(runner_path)")"
    printf '  <key>WorkingDirectory</key><string>%s</string>\n' "$(xml_escape "$PROJECT_ROOT")"
    printf '  <key>EnvironmentVariables</key>\n  <dict>\n    <key>NODE_ENV</key><string>production</string>\n    <key>PATH</key><string>%s</string>\n  </dict>\n' "$(xml_escape "${PATH:-/usr/local/bin:/usr/bin:/bin}")"
    printf '%s\n' '  <key>RunAtLoad</key><true/>' '  <key>KeepAlive</key><true/>'
    printf '  <key>StandardOutPath</key><string>%s</string>\n' "$(xml_escape "$(service_log_path)")"
    printf '  <key>StandardErrorPath</key><string>%s</string>\n' "$(xml_escape "$(service_log_path)")"
    printf '%s\n' '</dict>' '</plist>'
  } > "$plist"
  chmod 600 "$plist"
}

write_command_wrapper() {
  local wrapper
  wrapper="$BIN_DIR/$COMMAND_NAME"
  mkdir -p "$BIN_DIR"
  {
    printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
    printf 'export CODEX_DECK_DAEMON_PROJECT_ROOT=%s\n' "$(shell_quote "$PROJECT_ROOT")"
    printf 'export CODEX_DECK_DAEMON_CONFIG_HOME=%s\n' "$(shell_quote "$CONFIG_HOME")"
    printf 'export CODEX_DECK_DAEMON_STATE_DIR=%s\n' "$(shell_quote "$STATE_DIR")"
    printf 'export CODEX_DECK_DAEMON_BIN_DIR=%s\n' "$(shell_quote "$BIN_DIR")"
    printf 'export CODEX_DECK_DAEMON_NODE_BIN=%s\n' "$(shell_quote "$NODE_BIN")"
    printf 'export CODEX_DECK_DAEMON_SERVICE_MANAGER=%s\n' "$(shell_quote "$SERVICE_MANAGER")"
    printf 'export CODEX_DECK_DAEMON_ENV_FILE=%s\n' "$(shell_quote "$ENV_FILE")"
    printf 'exec %s "$@"\n' "$(shell_quote "$(daemon_lifecycle_script_path)")"
  } > "$wrapper"
  chmod 755 "$wrapper"
}

install_daemon() {
  PROJECT_ROOT="$(resolve_existing_dir "$PROJECT_ROOT")"
  CONFIG_HOME="$(resolve_path "$CONFIG_HOME")"
  STATE_DIR="$(resolve_path "$STATE_DIR")"
  BIN_DIR="$(resolve_path "$BIN_DIR")"
  if [[ -n "$ENV_FILE" ]]; then
    ENV_FILE="$(resolve_existing_file "$ENV_FILE")"
  fi

  [[ -f "$PROJECT_ROOT/package.json" ]] || die "package.json not found in $PROJECT_ROOT"
  if [[ "$BUILD_BEFORE_INSTALL" -eq 1 ]]; then
    command -v pnpm >/dev/null 2>&1 || die "pnpm is required to build the server"
    info "installing dependencies in $PROJECT_ROOT"
    pnpm --dir "$PROJECT_ROOT" install
    info "building $PROJECT_ROOT"
    pnpm --dir "$PROJECT_ROOT" build
  fi
  [[ -f "$PROJECT_ROOT/dist/index.js" ]] || die "built entrypoint not found: $PROJECT_ROOT/dist/index.js"

  if [[ -n "$NODE_BIN" ]]; then
    NODE_BIN="$(resolve_existing_file "$NODE_BIN")"
  else
    NODE_BIN="$(command -v node || true)"
    [[ -n "$NODE_BIN" ]] || die "node is required"
  fi
  SERVICE_MANAGER="$(detect_service_manager)"

  # Reinstalling updates the service definition without leaving an older
  # process running. Installation itself must finish in the stopped state.
  if service_is_installed; then
    case "$SERVICE_MANAGER" in
      systemd)
        systemctl --user disable --now "$SERVICE_NAME.service" >/dev/null 2>&1 || true
        ;;
      launchd)
        launchd_stop
        ;;
    esac
  fi

  mkdir -p "$STATE_DIR" "$BIN_DIR"
  chmod 700 "$STATE_DIR"
  install_lifecycle_script "$SCRIPT_DIR/install-daemon.sh"
  printf '%s\n' "$PROJECT_ROOT" > "$(active_project_root_path)"
  chmod 600 "$(active_project_root_path)"
  write_runner
  case "$SERVICE_MANAGER" in
    systemd) write_systemd_unit ;;
    launchd) write_launchd_plist ;;
  esac
  write_command_wrapper

  info "installed $SERVICE_MANAGER service"
  info "command: $BIN_DIR/$COMMAND_NAME start|stop|restart|status"
  if [[ ":${PATH}:" != *":$BIN_DIR:"* ]]; then
    info "add $BIN_DIR to PATH to use $COMMAND_NAME without its full path"
  fi
  info "run $BIN_DIR/$COMMAND_NAME start when ready"
}

uninstall_daemon() {
  SERVICE_MANAGER="$(detect_service_manager)"
  case "$SERVICE_MANAGER" in
    systemd)
      systemctl --user disable --now "$SERVICE_NAME.service" >/dev/null 2>&1 || true
      rm -f -- "$(unit_path)"
      systemctl --user daemon-reload
      ;;
    launchd)
      launchd_stop || true
      rm -f -- "$(plist_path)"
      ;;
  esac
  rm -f -- "$BIN_DIR/$COMMAND_NAME" "$(runner_path)" "$(daemon_lifecycle_script_path)"
  info "uninstalled service definitions and command"
  info "logs remain at $(service_log_path)"
}

ACTION="install"
if [[ $# -gt 0 && "$1" != -* ]]; then
  ACTION="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root)
      [[ $# -ge 2 ]] || die "--project-root requires a path"
      PROJECT_ROOT="$2"
      shift 2
      ;;
    --bin-dir)
      [[ $# -ge 2 ]] || die "--bin-dir requires a path"
      BIN_DIR="$2"
      shift 2
      ;;
    --env-file)
      [[ $# -ge 2 ]] || die "--env-file requires a path"
      ENV_FILE="$2"
      shift 2
      ;;
    --node)
      [[ $# -ge 2 ]] || die "--node requires a path"
      NODE_BIN="$2"
      shift 2
      ;;
    --service-manager)
      [[ $# -ge 2 ]] || die "--service-manager requires auto, systemd, or launchd"
      SERVICE_MANAGER="$2"
      shift 2
      ;;
    --no-build)
      BUILD_BEFORE_INSTALL=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

case "$ACTION" in
  install)
    install_daemon
    ;;
  start)
    SERVICE_MANAGER="$(detect_service_manager)"
    service_start
    ;;
  stop)
    SERVICE_MANAGER="$(detect_service_manager)"
    service_stop
    ;;
  restart)
    SERVICE_MANAGER="$(detect_service_manager)"
    service_restart
    ;;
  restart-after-update)
    SERVICE_MANAGER="$(detect_service_manager)"
    service_restart_after_update
    ;;
  status)
    SERVICE_MANAGER="$(detect_service_manager)"
    service_status
    ;;
  uninstall)
    uninstall_daemon
    ;;
  *)
    usage >&2
    die "unknown command: $ACTION"
    ;;
esac
