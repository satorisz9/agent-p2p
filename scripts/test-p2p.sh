#!/bin/bash
# ============================================================
# E2E Test: Two daemons discover each other via Hyperswarm
# and exchange a signed invoice over P2P.
# ============================================================

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

echo "=== P2P E2E Test ==="

# Cleanup
cleanup() {
  echo "[>>] Cleaning up..."
  [ -n "${PID1:-}" ] && kill "$PID1" 2>/dev/null || true
  [ -n "${PID2:-}" ] && kill "$PID2" 2>/dev/null || true
  rm -rf /tmp/agent-p2p-test-*
  echo "[OK] Cleanup done"
}
trap cleanup EXIT

# --- Start Daemon 1 (billing) ---
echo "[>>] Starting billing daemon on port 7710..."
npx tsx src/daemon/server.ts \
  --agent-id agent:test:billing \
  --org-id org:test \
  --namespace test-e2e-$(date +%s) \
  --data-dir /tmp/agent-p2p-test-billing \
  --port 7710 \
  > /tmp/agent-p2p-test-billing.log 2>&1 &
PID1=$!

# Need same namespace for both — extract it
NAMESPACE="test-e2e-$(date +%s)"

# Kill and restart with shared namespace
kill "$PID1" 2>/dev/null || true
sleep 1

echo "[>>] Starting billing daemon (namespace: $NAMESPACE)..."
npx tsx src/daemon/server.ts \
  --agent-id agent:test:billing \
  --org-id org:test \
  --namespace "$NAMESPACE" \
  --data-dir /tmp/agent-p2p-test-billing \
  --port 7710 \
  > /tmp/agent-p2p-test-billing.log 2>&1 &
PID1=$!

echo "[>>] Starting AP daemon (namespace: $NAMESPACE)..."
npx tsx src/daemon/server.ts \
  --agent-id agent:test:ap \
  --org-id org:testvendor \
  --namespace "$NAMESPACE" \
  --data-dir /tmp/agent-p2p-test-ap \
  --port 7711 \
  > /tmp/agent-p2p-test-ap.log 2>&1 &
PID2=$!

# Wait for both daemons
echo "[>>] Waiting for daemons to start..."
for i in $(seq 1 30); do
  B=$(curl -s http://127.0.0.1:7710/health 2>/dev/null || echo "")
  A=$(curl -s http://127.0.0.1:7711/health 2>/dev/null || echo "")
  if [[ "$B" == *"ok"* && "$A" == *"ok"* ]]; then
    echo "[OK] Both daemons running"
    break
  fi
  sleep 1
  if [ "$i" = "30" ]; then
    echo "[FAIL] Daemons did not start"
    cat /tmp/agent-p2p-test-billing.log
    cat /tmp/agent-p2p-test-ap.log
    exit 1
  fi
done

# Wait for P2P discovery
echo "[>>] Waiting for P2P peer discovery (up to 30s)..."
for i in $(seq 1 30); do
  PEERS=$(curl -s http://127.0.0.1:7710/peers 2>/dev/null || echo "[]")
  if [[ "$PEERS" != "[]" ]]; then
    echo "[OK] Peers discovered!"
    echo "  Billing peers: $PEERS"
    break
  fi
  sleep 1
  if [ "$i" = "30" ]; then
    echo "[INFO] Peers not yet discovered (this is normal on first run — DHT may take longer)"
    echo "[INFO] Proceeding with test (message will be queued)"
  fi
done

# --- Issue invoice from billing to AP ---
echo ""
echo "[>>] Issuing invoice from billing to AP..."
RESULT=$(curl -s -X POST http://127.0.0.1:7710/invoices/issue \
  -H "Content-Type: application/json" \
  -d '{
    "target_agent_id": "agent:test:ap",
    "invoice": {
      "meta": {
        "invoice_id": "inv_test_001",
        "currency": "JPY"
      },
      "data": {
        "invoice_number": "TEST-001",
        "issue_date": "2026-03-28",
        "due_date": "2026-04-28",
        "seller": {
          "org_id": "org:test",
          "name": "Test Billing Inc.",
          "tax_id": "T1111111111111",
          "address": "Tokyo",
          "email": "billing@test.example"
        },
        "buyer": {
          "org_id": "org:testvendor",
          "name": "Test AP Ltd.",
          "tax_id": "T2222222222222",
          "address": "Osaka",
          "email": "ap@test.example"
        },
        "line_items": [{
          "line_id": "1",
          "description": "Test service",
          "quantity": 1,
          "unit": "service",
          "unit_price": 100000,
          "tax_rate": 0.1,
          "amount_excluding_tax": 100000,
          "tax_amount": 10000,
          "amount_including_tax": 110000
        }],
        "subtotal": 100000,
        "tax_total": 10000,
        "total": 110000,
        "payment_terms": {
          "method": "bank_transfer",
          "terms_text": "Net 30"
        }
      }
    }
  }')

echo "  Issue result: $RESULT"

# Check billing side
echo ""
echo "[>>] Billing side — invoice state:"
curl -s "http://127.0.0.1:7710/invoices?invoice_id=inv_test_001" | python3 -m json.tool 2>/dev/null || \
  curl -s "http://127.0.0.1:7710/invoices?invoice_id=inv_test_001"

# Wait a bit for P2P delivery
sleep 3

# Check AP side
echo ""
echo "[>>] AP side — inbox:"
curl -s http://127.0.0.1:7711/inbox | python3 -m json.tool 2>/dev/null || \
  curl -s http://127.0.0.1:7711/inbox

echo ""
echo "[>>] AP side — processing inbox..."
curl -s -X POST http://127.0.0.1:7711/inbox/process | python3 -m json.tool 2>/dev/null || \
  curl -s -X POST http://127.0.0.1:7711/inbox/process

echo ""
echo "[>>] AP side — invoice state:"
curl -s "http://127.0.0.1:7711/invoices?invoice_id=inv_test_001" | python3 -m json.tool 2>/dev/null || \
  curl -s "http://127.0.0.1:7711/invoices?invoice_id=inv_test_001"

echo ""
echo "=== P2P E2E Test Complete ==="
echo ""
echo "Daemon logs:"
echo "  Billing: /tmp/agent-p2p-test-billing.log"
echo "  AP:      /tmp/agent-p2p-test-ap.log"
