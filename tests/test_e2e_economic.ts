/**
 * E2E Economic Tests — Persistence & P2P Transfer
 *
 * Tests:
 *   1. Token/wallet state persists across daemon restart
 *   2. P2P transfer between two daemons credits recipient
 *   3. Ledger integrity survives restart
 *   4. Escrow state persists across restart
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "child_process";
import { readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";

const PORT_A = 7720;
const PORT_B = 7721;
const DATA_A = "/tmp/agent-p2p-e2e-eco-a";
const DATA_B = "/tmp/agent-p2p-e2e-eco-b";
const AGENT_A = "agent:eco:alice";
const AGENT_B = "agent:eco:bob";
const NAMESPACE = "e2e-test-economic";

let procA: ChildProcess;
let procB: ChildProcess;
let tokenA: string;
let tokenB: string;

async function api(port: number, token: string, method: string, path: string, body?: any): Promise<any> {
  const url = `http://127.0.0.1:${port}${path}`;
  const opts: RequestInit = {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text, _status: res.status };
  }
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForDaemon(port: number, maxMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`Daemon on port ${port} did not start within ${maxMs}ms`);
}

async function waitForPort(port: number, maxMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
      return; // Port is still responding
    } catch {
      return; // Port is free — daemon stopped
    }
  }
}

function startDaemon(agentId: string, orgId: string, port: number, dataDir: string): ChildProcess {
  const proc = spawn("npx", [
    "tsx", "src/daemon/server.ts",
    "--agent-id", agentId,
    "--org-id", orgId,
    "--namespace", NAMESPACE,
    "--data-dir", dataDir,
    "--port", String(port),
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENT_P2P_PASSPHRASE: "e2e-test" },
  });

  proc.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) process.stderr.write(`[${agentId}] ${line}\n`);
  });

  return proc;
}

async function stopDaemon(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    proc.on("exit", () => resolve());
    proc.kill("SIGTERM");
    // Force kill after 5s
    setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 5000);
  });
}

// ============================================================
// Test Suite 1: Persistence across restart
// ============================================================

describe("Economic Persistence", () => {
  before(async () => {
    if (existsSync(DATA_A)) rmSync(DATA_A, { recursive: true });
  });

  after(() => {
    procA?.kill("SIGTERM");
    if (existsSync(DATA_A)) rmSync(DATA_A, { recursive: true });
  });

  it("creates token and wallet, verifies persistence after restart", async () => {
    // Start daemon A
    procA = startDaemon(AGENT_A, "org:eco", PORT_A, DATA_A);
    await waitForDaemon(PORT_A);
    tokenA = readFileSync(join(DATA_A, "api-token"), "utf8").trim();

    // Issue a token
    const token = await api(PORT_A, tokenA, "POST", "/token/issue", {
      name: "PersistCoin",
      symbol: "PERS",
      decimals: 18,
      initial_supply: 5000,
    });
    assert.ok(token.token_id, "Token should be created");
    assert.equal(token.symbol, "PERS");

    // Check balance
    const balance1 = await api(PORT_A, tokenA, "GET", `/wallet/balance?token_id=${token.token_id}`);
    assert.equal(balance1.balance, 5000);

    // Verify state file exists on disk
    const stateFile = join(DATA_A, "economic-state.json");
    assert.ok(existsSync(stateFile), "economic-state.json should exist");

    // Mint more
    const mintResult = await api(PORT_A, tokenA, "POST", "/token/mint", {
      token_id: token.token_id,
      amount: 1000,
    });
    assert.ok(mintResult.success);

    // Verify ledger
    const ledger1 = await api(PORT_A, tokenA, "GET", "/ledger");
    assert.ok(ledger1.entries.length >= 2, "Should have mint entries");

    // --- Stop daemon ---
    await stopDaemon(procA);
    await sleep(1000); // Wait for port to free up

    // --- Restart daemon ---
    procA = startDaemon(AGENT_A, "org:eco", PORT_A, DATA_A);
    await waitForDaemon(PORT_A);
    // API token is the same (persisted)
    const tokenA2 = readFileSync(join(DATA_A, "api-token"), "utf8").trim();
    assert.equal(tokenA2, tokenA, "API token should persist");

    // Verify token still exists
    const tokens = await api(PORT_A, tokenA, "GET", "/token/list");
    assert.equal(tokens.tokens.length, 1, "Token should persist");
    assert.equal(tokens.tokens[0].symbol, "PERS");

    // Verify balance persisted (initial 5000 + mint 1000)
    const balance2 = await api(PORT_A, tokenA, "GET", `/wallet/balance?token_id=${token.token_id}`);
    assert.equal(balance2.balance, 6000, "Balance should persist across restart");

    // Verify ledger persisted
    const ledger2 = await api(PORT_A, tokenA, "GET", "/ledger");
    assert.equal(ledger2.entries.length, ledger1.entries.length, "Ledger should persist");

    // Verify ledger integrity
    const integrity = await api(PORT_A, tokenA, "GET", "/ledger/verify");
    assert.ok(integrity.valid, "Ledger hash chain should be valid after restart");
  });

  it("escrow state persists across restart", async () => {
    // Issue a token (daemon A already running from previous test)
    const token = await api(PORT_A, tokenA, "POST", "/token/issue", {
      name: "EscrowCoin",
      symbol: "ESC",
      decimals: 18,
      initial_supply: 10000,
    });

    // Create offer and lock escrow
    const offer = await api(PORT_A, tokenA, "POST", "/offer/create", {
      task_id: "persist-task-1",
      to: AGENT_B,
      token_id: token.token_id,
      amount: 500,
    });
    assert.ok(offer.offer_id);

    const lockResult = await api(PORT_A, tokenA, "POST", "/escrow/lock", {
      offer_id: offer.offer_id,
    });
    assert.ok(lockResult.success, "Escrow should lock");

    const escrowId = lockResult.escrow.escrow_id;

    // --- Restart ---
    await stopDaemon(procA);
    await sleep(1000);
    procA = startDaemon(AGENT_A, "org:eco", PORT_A, DATA_A);
    await waitForDaemon(PORT_A);

    // Verify escrow persisted
    const escrows = await api(PORT_A, tokenA, "GET", "/escrow/list");
    const persisted = escrows.escrows.find((e: any) => e.escrow_id === escrowId);
    assert.ok(persisted, "Escrow should persist");
    assert.equal(persisted.status, "locked");
    assert.equal(persisted.amount, 500);

    // Balance should reflect the locked amount
    const balance = await api(PORT_A, tokenA, "GET", `/wallet/balance?token_id=${token.token_id}`);
    assert.equal(balance.balance, 9500, "Balance should reflect locked escrow after restart");
  });
});

// ============================================================
// Test Suite 2: P2P Transfer between daemons
// ============================================================

describe("P2P Token Transfer", () => {
  before(async () => {
    if (existsSync(DATA_A)) rmSync(DATA_A, { recursive: true });
    if (existsSync(DATA_B)) rmSync(DATA_B, { recursive: true });

    procA = startDaemon(AGENT_A, "org:eco", PORT_A, DATA_A);
    procB = startDaemon(AGENT_B, "org:eco", PORT_B, DATA_B);

    await Promise.all([
      waitForDaemon(PORT_A),
      waitForDaemon(PORT_B),
    ]);

    tokenA = readFileSync(join(DATA_A, "api-token"), "utf8").trim();
    tokenB = readFileSync(join(DATA_B, "api-token"), "utf8").trim();

    // Connect the two daemons via invite
    const invite = await api(PORT_A, tokenA, "POST", "/invite/create", {});
    assert.ok(invite.code, "Should get invite code");

    const accept = await api(PORT_B, tokenB, "POST", "/invite/accept", { code: invite.code });
    assert.ok(accept.success || accept.peer_agent_id, "Invite should be accepted");

    // Wait for P2P connection to establish
    await sleep(3000);
  });

  after(() => {
    procA?.kill("SIGTERM");
    procB?.kill("SIGTERM");
    if (existsSync(DATA_A)) rmSync(DATA_A, { recursive: true });
    if (existsSync(DATA_B)) rmSync(DATA_B, { recursive: true });
  });

  it("transfer credits recipient daemon via P2P", async () => {
    // Alice issues token
    const token = await api(PORT_A, tokenA, "POST", "/token/issue", {
      name: "TransferCoin",
      symbol: "XFER",
      decimals: 18,
      initial_supply: 10000,
    });
    assert.ok(token.token_id);

    // Alice transfers to Bob via P2P
    const result = await api(PORT_A, tokenA, "POST", "/token/transfer", {
      to: AGENT_B,
      token_id: token.token_id,
      amount: 3000,
    });
    assert.ok(result.success, `Transfer should succeed: ${JSON.stringify(result)}`);

    // Alice balance should decrease
    const aliceBalance = await api(PORT_A, tokenA, "GET", `/wallet/balance?token_id=${token.token_id}`);
    assert.equal(aliceBalance.balance, 7000);

    // Wait for P2P message to propagate
    await sleep(2000);

    // Bob should have received the tokens
    const bobBalance = await api(PORT_B, tokenB, "GET", `/wallet/balance?token_id=${token.token_id}`);
    assert.equal(bobBalance.balance, 3000, "Bob should receive transferred tokens via P2P");

    // Bob's ledger should have an entry
    const bobLedger = await api(PORT_B, tokenB, "GET", "/ledger");
    assert.ok(bobLedger.entries.length > 0, "Bob should have ledger entries");
    const transferEntry = bobLedger.entries.find((e: any) => e.entry_type === "transfer");
    assert.ok(transferEntry, "Bob should have a transfer ledger entry");
    assert.equal(transferEntry.amount, 3000);
    assert.equal(transferEntry.from, AGENT_A);
  });

  it("multiple transfers accumulate correctly", async () => {
    // Issue another token
    const token = await api(PORT_A, tokenA, "POST", "/token/issue", {
      name: "MultiCoin",
      symbol: "MULTI",
      decimals: 18,
      initial_supply: 5000,
    });

    // Send 3 transfers
    for (const amount of [100, 200, 300]) {
      const r = await api(PORT_A, tokenA, "POST", "/token/transfer", {
        to: AGENT_B,
        token_id: token.token_id,
        amount,
      });
      assert.ok(r.success, `Transfer ${amount} should succeed`);
    }

    await sleep(3000);

    const aliceBalance = await api(PORT_A, tokenA, "GET", `/wallet/balance?token_id=${token.token_id}`);
    assert.equal(aliceBalance.balance, 4400, "Alice: 5000 - 100 - 200 - 300 = 4400");

    const bobBalance = await api(PORT_B, tokenB, "GET", `/wallet/balance?token_id=${token.token_id}`);
    assert.equal(bobBalance.balance, 600, "Bob: 100 + 200 + 300 = 600");
  });

  it("transfer to offline peer succeeds locally (queued)", async () => {
    const token = await api(PORT_A, tokenA, "POST", "/token/issue", {
      name: "QueueCoin",
      symbol: "QUE",
      decimals: 18,
      initial_supply: 1000,
    });

    // Transfer to a non-existent agent — should succeed locally
    const result = await api(PORT_A, tokenA, "POST", "/token/transfer", {
      to: "agent:eco:charlie" as any,
      token_id: token.token_id,
      amount: 100,
    });
    assert.ok(result.success, "Transfer should succeed locally even if peer offline");

    // Alice balance should decrease
    const balance = await api(PORT_A, tokenA, "GET", `/wallet/balance?token_id=${token.token_id}`);
    assert.equal(balance.balance, 900);
  });

  it("transfer with insufficient balance fails", async () => {
    const token = await api(PORT_A, tokenA, "POST", "/token/issue", {
      name: "PoorCoin",
      symbol: "POOR",
      decimals: 18,
      initial_supply: 100,
    });

    const result = await api(PORT_A, tokenA, "POST", "/token/transfer", {
      to: AGENT_B,
      token_id: token.token_id,
      amount: 999,
    });
    assert.ok(!result.success, "Transfer should fail with insufficient balance");
    assert.ok(result.error?.includes("Insufficient"));
  });

  it("recipient state persists after their daemon restarts", async () => {
    // Issue and transfer
    const token = await api(PORT_A, tokenA, "POST", "/token/issue", {
      name: "RestartCoin",
      symbol: "RST",
      decimals: 18,
      initial_supply: 2000,
    });

    await api(PORT_A, tokenA, "POST", "/token/transfer", {
      to: AGENT_B,
      token_id: token.token_id,
      amount: 750,
    });
    await sleep(2000);

    // Verify Bob got the tokens
    const bobBefore = await api(PORT_B, tokenB, "GET", `/wallet/balance?token_id=${token.token_id}`);
    assert.equal(bobBefore.balance, 750);

    // Restart Bob's daemon
    await stopDaemon(procB);
    await sleep(1000);
    procB = startDaemon(AGENT_B, "org:eco", PORT_B, DATA_B);
    await waitForDaemon(PORT_B);

    // Bob's balance should persist
    const bobAfter = await api(PORT_B, tokenB, "GET", `/wallet/balance?token_id=${token.token_id}`);
    assert.equal(bobAfter.balance, 750, "Bob's received balance should persist across restart");
  });
});
