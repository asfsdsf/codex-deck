#!/bin/bash
set -euo pipefail
set -x

container_name="codexdeck-server-3005"

wait_for_container_removal() {
  local name="$1"
  local attempts=0

  while docker container inspect "$name" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 50 ]; then
      echo "Timed out waiting for container '$name' to be removed" >&2
      exit 1
    fi
    sleep 0.2
  done
}

docker build -t codexdeck-server -f Dockerfile.server .

if docker container inspect "$container_name" >/dev/null 2>&1; then
  docker stop "$container_name" >/dev/null 2>&1 || true
  docker rm "$container_name" >/dev/null 2>&1 || true
  wait_for_container_removal "$container_name"
fi

docker run --rm \
  --name "$container_name" \
  -p 3005:3005 \
  -e CODEXDECK_REMOTE_ADMIN_PASSWORD='admin-password' \
  -e CODEXDECK_SERVER_LOG_LEVEL='warn' \
  -e PUBLIC_URL='http://localhost:3005' \
  -v codexdeck-data:/data \
  codexdeck-server
