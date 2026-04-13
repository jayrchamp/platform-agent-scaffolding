#!/bin/sh
# Ensure data directories exist and are writable by the agent user.
# This runs as root before dropping to the 'agent' user.

STATE_PATH="${STATE_PATH:-/data}"

mkdir -p "$STATE_PATH/appspecs" 2>/dev/null || true
chown -R agent:agent "$STATE_PATH/appspecs" 2>/dev/null || true
chown agent:agent "$STATE_PATH/operations.log" 2>/dev/null || true
chown agent:agent "$STATE_PATH/agent.yaml" 2>/dev/null || true

# Drop to agent user and run the app
exec su-exec agent node dist/server.js
