#!/bin/bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: build-packages.sh [--out-dir <dir>] [--node-version <semver>] [--targets <csv>]

Build self-contained codex-deck packages into ./build by default.

Supported targets:
  - linux-x64
  - macos-arm64
  - macos-x64
  - windows-x64

Notes:
  - linux-x64 requires either a Linux host or Docker when run from macOS/Windows.
  - Artifacts are portable archives (.tar.gz/.zip), not native OS installers.
EOF
}

fail() {
  echo "[ERROR] $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

OUT_DIR="$ROOT/build"
NODE_VERSION=""
TARGETS_CSV="linux-x64,macos-arm64,macos-x64,windows-x64"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      [[ $# -ge 2 ]] || fail "--out-dir requires a value"
      OUT_DIR="$2"
      shift 2
      ;;
    --node-version)
      [[ $# -ge 2 ]] || fail "--node-version requires a value"
      NODE_VERSION="$2"
      shift 2
      ;;
    --targets)
      [[ $# -ge 2 ]] || fail "--targets requires a value"
      TARGETS_CSV="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unexpected argument: $1"
      ;;
  esac
done

require_cmd node
require_cmd pnpm
require_cmd npm
require_cmd curl
require_cmd tar
require_cmd unzip
require_cmd zip

PACKAGE_NAME="$(node -p "require('./package.json').name")"
[[ "$PACKAGE_NAME" == "codex-deck" ]] || fail "This script must run inside the codex-deck repo"

VERSION="$(node -p "require('./package.json').version")"
NODE_VERSION="${NODE_VERSION:-$(node -p 'process.version.slice(1)')}"

IFS=',' read -r -a RAW_TARGETS <<< "$TARGETS_CSV"
TARGETS=()
for raw_target in "${RAW_TARGETS[@]}"; do
  target="$(echo "$raw_target" | tr -d '[:space:]')"
  [[ -n "$target" ]] || continue
  case "$target" in
    linux-x64|macos-arm64|macos-x64|windows-x64)
      TARGETS+=("$target")
      ;;
    *)
      fail "Unsupported target: $target"
      ;;
  esac
done

[[ "${#TARGETS[@]}" -gt 0 ]] || fail "No targets selected"

WORK_DIR="$OUT_DIR/.work"
DOWNLOADS_DIR="$OUT_DIR/.downloads"
HOST_TEMPLATE="$WORK_DIR/app-template-host"
LINUX_TEMPLATE="$WORK_DIR/app-template-linux-x64"

rm -rf "$WORK_DIR" "$DOWNLOADS_DIR"
mkdir -p "$OUT_DIR" "$WORK_DIR" "$DOWNLOADS_DIR"
find "$OUT_DIR" -maxdepth 1 -type f \( -name 'codex-deck-v*.tar.gz' -o -name 'codex-deck-v*.zip' \) -delete

pnpm build >/dev/null

create_app_template() {
  local template_dir="$1"
  rm -rf "$template_dir"
  mkdir -p "$template_dir/vendor/zuoyehaoduoa-wire"

  node - "$template_dir/package.json" <<'NODE'
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const outFile = process.argv[2];
const input = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const depNames = Object.keys(input.dependencies || {}).sort();

function resolveInstalledVersion(name) {
  const entry = require.resolve(name, { paths: [root] });
  let dir = path.dirname(entry);
  while (dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.name === name && typeof pkg.version === "string") {
        return pkg.version;
      }
    }
    dir = path.dirname(dir);
  }
  throw new Error(`Could not resolve installed version for ${name}`);
}

const exactDependencies = {};
for (const name of depNames) {
  if (name === "@zuoyehaoduoa/wire") {
    exactDependencies[name] = "file:vendor/zuoyehaoduoa-wire";
    continue;
  }
  exactDependencies[name] = resolveInstalledVersion(name);
}

const output = {
  name: input.name,
  version: input.version,
  description: input.description,
  type: input.type,
  bin: input.bin,
  main: input.main,
  engines: input.engines,
  license: input.license,
  dependencies: exactDependencies,
};

fs.writeFileSync(outFile, JSON.stringify(output, null, 2) + "\n");
NODE

  cat <<'EOF' > "$template_dir/README.txt"
Portable Codex Deck bundle

Quick start:
- macOS/Linux: run ./codex-deck
- Windows: run codex-deck.cmd

Useful options:
- --port 12001
- --dir ~/.codex
- --no-open
EOF

  cp -R dist "$template_dir/dist"
  cp LICENSE "$template_dir/LICENSE"
  cp README.md "$template_dir/README.md"
  cp -R wire/dist "$template_dir/vendor/zuoyehaoduoa-wire/dist"
  cp wire/package.json "$template_dir/vendor/zuoyehaoduoa-wire/package.json"
  cp wire/README.md "$template_dir/vendor/zuoyehaoduoa-wire/README.md"
}

install_template_deps() {
  local template_dir="$1"
  (
    cd "$template_dir"
    npm install --omit=dev --no-audit --no-fund --package-lock=false >/dev/null
  )
}

materialize_workspace_packages() {
  local template_dir="$1"
  local node_modules_scope_dir="$template_dir/node_modules/@zuoyehaoduoa"
  local wire_source_dir="$template_dir/vendor/zuoyehaoduoa-wire"
  local wire_target_dir="$node_modules_scope_dir/wire"

  rm -rf "$wire_target_dir"
  mkdir -p "$node_modules_scope_dir"
  cp -R "$wire_source_dir" "$wire_target_dir"
  rm -rf "$template_dir/vendor"
}

prepare_host_template() {
  create_app_template "$HOST_TEMPLATE"
  install_template_deps "$HOST_TEMPLATE"
  materialize_workspace_packages "$HOST_TEMPLATE"
}

prepare_linux_template() {
  create_app_template "$LINUX_TEMPLATE"
  if [[ "$(uname -s)" == "Linux" ]]; then
    install_template_deps "$LINUX_TEMPLATE"
    materialize_workspace_packages "$LINUX_TEMPLATE"
    return
  fi

  command -v docker >/dev/null 2>&1 || fail \
    "linux-x64 packaging requires Docker on non-Linux hosts because node-pty must be installed on Linux"

  docker run --rm \
    -v "$LINUX_TEMPLATE:/workspace" \
    -w /workspace \
    "node:$NODE_VERSION-bookworm" \
    bash -lc "
      set -euo pipefail
      export DEBIAN_FRONTEND=noninteractive
      apt-get update >/dev/null
      apt-get install -y python3 make g++ >/dev/null
      npm install --omit=dev --no-audit --no-fund --package-lock=false >/dev/null
      chown -R $(id -u):$(id -g) /workspace
    "

  materialize_workspace_packages "$LINUX_TEMPLATE"
}

write_unix_launcher() {
  local bundle_root="$1"
  cat <<'EOF' > "$bundle_root/codex-deck"
#!/bin/sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$SCRIPT_DIR/runtime/bin/node" "$SCRIPT_DIR/app/dist/index.js" "$@"
EOF
  chmod +x "$bundle_root/codex-deck"
}

write_windows_launcher() {
  local bundle_root="$1"
  cat <<'EOF' > "$bundle_root/codex-deck.cmd"
@echo off
set SCRIPT_DIR=%~dp0
"%SCRIPT_DIR%runtime\node.exe" "%SCRIPT_DIR%app\dist\index.js" %*
EOF
}

make_unix_bundle() {
  local template_dir="$1"
  local target="$2"
  local node_archive_name="$3"
  local node_archive_url="$4"
  local tar_flag="$5"
  local bundle_name="codex-deck-v$VERSION-$target"
  local target_dir="$WORK_DIR/$target"
  local bundle_root="$target_dir/$bundle_name"

  rm -rf "$target_dir"
  mkdir -p "$target_dir" "$bundle_root/runtime"
  cp -R "$template_dir" "$bundle_root/app"
  curl -L --fail -o "$DOWNLOADS_DIR/$node_archive_name" "$node_archive_url"
  tar "$tar_flag" "$DOWNLOADS_DIR/$node_archive_name" -C "$bundle_root/runtime" --strip-components=1
  write_unix_launcher "$bundle_root"
  tar -czf "$OUT_DIR/$bundle_name.tar.gz" -C "$target_dir" "$bundle_name"
}

make_windows_bundle() {
  local template_dir="$1"
  local bundle_name="codex-deck-v$VERSION-windows-x64"
  local target_dir="$WORK_DIR/windows-x64"
  local bundle_root="$target_dir/$bundle_name"
  local archive_name="node-v$NODE_VERSION-win-x64.zip"
  local archive_url="https://nodejs.org/dist/v$NODE_VERSION/$archive_name"

  rm -rf "$target_dir"
  mkdir -p "$target_dir" "$bundle_root"
  cp -R "$template_dir" "$bundle_root/app"
  curl -L --fail -o "$DOWNLOADS_DIR/$archive_name" "$archive_url"
  unzip -q "$DOWNLOADS_DIR/$archive_name" -d "$target_dir"
  mv "$target_dir/node-v$NODE_VERSION-win-x64" "$bundle_root/runtime"
  write_windows_launcher "$bundle_root"
  (
    cd "$target_dir"
    zip -qry "$OUT_DIR/$bundle_name.zip" "$bundle_name"
  )
}

verify_local_bundle() {
  local verify_dir="$WORK_DIR/verify"
  rm -rf "$verify_dir"
  mkdir -p "$verify_dir"

  case "$(uname -s):$(uname -m)" in
    Darwin:arm64)
      local archive="$OUT_DIR/codex-deck-v$VERSION-macos-arm64.tar.gz"
      [[ -f "$archive" ]] || return 0
      tar -xzf "$archive" -C "$verify_dir"
      "$verify_dir/codex-deck-v$VERSION-macos-arm64/codex-deck" --version >/dev/null
      ;;
    Darwin:x86_64)
      local archive="$OUT_DIR/codex-deck-v$VERSION-macos-x64.tar.gz"
      [[ -f "$archive" ]] || return 0
      tar -xzf "$archive" -C "$verify_dir"
      "$verify_dir/codex-deck-v$VERSION-macos-x64/codex-deck" --version >/dev/null
      ;;
    Linux:x86_64)
      local archive="$OUT_DIR/codex-deck-v$VERSION-linux-x64.tar.gz"
      [[ -f "$archive" ]] || return 0
      tar -xzf "$archive" -C "$verify_dir"
      "$verify_dir/codex-deck-v$VERSION-linux-x64/codex-deck" --version >/dev/null
      ;;
  esac
}

needs_host_template=0
needs_linux_template=0
for target in "${TARGETS[@]}"; do
  case "$target" in
    linux-x64)
      needs_linux_template=1
      ;;
    *)
      needs_host_template=1
      ;;
  esac
done

if [[ "$needs_host_template" == "1" ]]; then
  prepare_host_template
fi

if [[ "$needs_linux_template" == "1" ]]; then
  prepare_linux_template
fi

for target in "${TARGETS[@]}"; do
  case "$target" in
    linux-x64)
      make_unix_bundle \
        "$LINUX_TEMPLATE" \
        "linux-x64" \
        "node-v$NODE_VERSION-linux-x64.tar.xz" \
        "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" \
        -xJf
      ;;
    macos-arm64)
      make_unix_bundle \
        "$HOST_TEMPLATE" \
        "macos-arm64" \
        "node-v$NODE_VERSION-darwin-arm64.tar.gz" \
        "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz" \
        -xzf
      ;;
    macos-x64)
      make_unix_bundle \
        "$HOST_TEMPLATE" \
        "macos-x64" \
        "node-v$NODE_VERSION-darwin-x64.tar.gz" \
        "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-x64.tar.gz" \
        -xzf
      ;;
    windows-x64)
      make_windows_bundle "$HOST_TEMPLATE"
      ;;
  esac
done

verify_local_bundle

find "$OUT_DIR" -maxdepth 1 -type f \( -name '*.tar.gz' -o -name '*.zip' \) | sort
