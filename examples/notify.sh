#!/bin/bash
# notify.sh — Send a notification to a peer agent via agent-p2p
# Usage: notify.sh <target-agent-id> "message"
#
# Example:
#   notify.sh agent:myorg:local "build completed: all tests passed"
#
# Prerequisites:
#   - agent-p2p daemon running (default: http://127.0.0.1:7700)
#   - API token in $DATA_DIR/api-token
#   - Target agent connected as peer

set -euo pipefail

DATA_DIR="${AGENT_P2P_DATA_DIR:-$HOME/.agent-p2p/default}"
DAEMON="${AGENT_P2P_DAEMON_URL:-http://127.0.0.1:7700}"
TARGET="${1:?Usage: notify.sh <target-agent-id> \"message\"}"
MSG="${2:-task completed}"

TOKEN=$(cat "$DATA_DIR/api-token")

curl -sf -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg target "$TARGET" --arg msg "$MSG" '{
    target_agent_id: $target,
    type: "report",
    description: $msg,
    input: { source: "notify.sh", timestamp: (now | tostring) }
  }')" \
  "$DAEMON/task/request" > /dev/null

echo "[notify] sent to $TARGET: $MSG"
