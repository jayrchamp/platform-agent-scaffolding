#!/bin/sh
# ── Platform Agent Entrypoint ────────────────────────────────────────────────
#
# Runs as root initially to:
#   1. Ensure data directories exist with correct ownership
#   2. Grant docker.sock access to the agent user
# Then drops privileges to 'agent' (UID 10001) via su-exec.

set -e

STATE_PATH="${STATE_PATH:-/data}"

# ── Fix volume ownership ────────────────────────────────────────────────────
# Only chown the specific subdirectories the agent writes to.
# NEVER chown $STATE_PATH recursively — it's /opt/platform which also contains
# postgres/data (owned by UID 70), traefik/certs, etc.
mkdir -p "$STATE_PATH/appspecs" 2>/dev/null || true
mkdir -p "$STATE_PATH/builds" 2>/dev/null || true
chown -R agent:agent "$STATE_PATH/appspecs" 2>/dev/null || true
chown -R agent:agent "$STATE_PATH/builds" 2>/dev/null || true
chown -R agent:agent /logs 2>/dev/null || true

# ── Docker socket access ────────────────────────────────────────────────────
# The agent needs read access to docker.sock for container management.
# Dynamically match the host's docker GID so we don't hardcode it.
if [ -S /var/run/docker.sock ]; then
  DOCKER_GID=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo "")
  if [ -n "$DOCKER_GID" ] && [ "$DOCKER_GID" != "0" ]; then
    addgroup -g "$DOCKER_GID" docker-host 2>/dev/null || true
    addgroup agent docker-host 2>/dev/null || true
  fi
fi

# ── Drop privileges and start ───────────────────────────────────────────────
exec su-exec agent node dist/server.js
