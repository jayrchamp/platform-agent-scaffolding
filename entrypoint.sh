#!/bin/sh
# Ensure data directories exist and are writable.
# Runs as root (via docker run --user root).
#
# TODO: Once volume permissions are properly handled in bootstrap,
#       restore su-exec agent to drop privileges here.

STATE_PATH="${STATE_PATH:-/data}"

mkdir -p "$STATE_PATH/appspecs" 2>/dev/null || true

# Run Node as the current user (root when --user root is set)
exec node dist/server.js
