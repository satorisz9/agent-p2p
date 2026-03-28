#!/bin/bash
# ============================================================
# Agent P2P — Quick Setup
#
# Creates a daemon + registers MCP server for Claude Code.
#
# Usage:
#   ./scripts/setup-agent.sh billing agent:mindaxis:billing org:mindaxis invoices-2026 7700
#   ./scripts/setup-agent.sh ap agent:vendorx:ap org:vendorx invoices-2026 7701
#
# Args: <name> <agent-id> <org-id> <namespace> <port>
# ============================================================

set -euo pipefail

NAME="${1:?Usage: setup-agent.sh <name> <agent-id> <org-id> <namespace> <port>}"
AGENT_ID="${2:?}"
ORG_ID="${3:?}"
NAMESPACE="${4:?}"
PORT="${5:?}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$HOME/.agent-p2p/$NAME"

echo "=== Agent P2P Setup ==="
echo "Name:      $NAME"
echo "Agent ID:  $AGENT_ID"
echo "Org ID:    $ORG_ID"
echo "Namespace: $NAMESPACE"
echo "Port:      $PORT"
echo "Data Dir:  $DATA_DIR"
echo ""

# --- 1. Create data directory ---
mkdir -p "$DATA_DIR"

# --- 2. Start daemon (if not already running) ---
if curl -s "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "[OK] Daemon already running on port $PORT"
else
  echo "[>>] Starting daemon..."
  # Use npx tsx for TypeScript execution
  nohup npx tsx "$PROJECT_DIR/src/daemon/server.ts" \
    --agent-id "$AGENT_ID" \
    --org-id "$ORG_ID" \
    --namespace "$NAMESPACE" \
    --data-dir "$DATA_DIR" \
    --port "$PORT" \
    > "$DATA_DIR/daemon.log" 2>&1 &

  DAEMON_PID=$!
  echo "$DAEMON_PID" > "$DATA_DIR/daemon.pid"

  # Wait for daemon to be ready
  for i in $(seq 1 30); do
    if curl -s "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      echo "[OK] Daemon started (PID $DAEMON_PID)"
      break
    fi
    sleep 1
    if [ "$i" = "30" ]; then
      echo "[FAIL] Daemon did not start. Check $DATA_DIR/daemon.log"
      exit 1
    fi
  done
fi

# --- 3. Register MCP server with Claude Code ---
echo ""
echo "[>>] Registering MCP server with Claude Code..."

# claude mcp add uses -- to separate command and args
claude mcp add "$NAME" \
  -s user \
  -- npx tsx "$PROJECT_DIR/src/mcp/server.ts" \
  --daemon-url "http://127.0.0.1:$PORT" \
  2>/dev/null && echo "[OK] MCP server registered: $NAME" \
  || echo "[WARN] Could not auto-register MCP. Add manually:"

echo ""
echo "=== Manual MCP registration (if auto failed) ==="
echo ""
echo "  claude mcp add $NAME -- npx tsx $PROJECT_DIR/src/mcp/server.ts --daemon-url http://127.0.0.1:$PORT"
echo ""

# --- 4. Show agent info ---
echo "=== Agent Info ==="
curl -s "http://127.0.0.1:$PORT/info" | python3 -m json.tool 2>/dev/null || \
  curl -s "http://127.0.0.1:$PORT/info"
echo ""
echo "=== Done ==="
echo ""
echo "Next steps:"
echo "  1. Start Claude Code"
echo "  2. The '$NAME' MCP tools are now available"
echo "  3. Try: 'Use the $NAME agent to list invoices'"
echo ""
echo "Daemon management:"
echo "  Status:  curl http://127.0.0.1:$PORT/health"
echo "  Logs:    tail -f $DATA_DIR/daemon.log"
echo "  Stop:    kill \$(cat $DATA_DIR/daemon.pid)"
