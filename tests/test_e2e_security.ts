/**
 * E2E Security Integration Test
 *
 * Spins up two agent daemons (A & B), connects them via invite,
 * then runs the full security flow:
 *   Token issuance → Transfer → Task + Escrow → Verification → Payment → Reputation
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "child_process";
import { readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";

const PORT_A = 7710;
const PORT_B = 7711;
const DATA_A = "/tmp/agent-p2p-e2e-a";
const DATA_B = "/tmp/agent-p2p-e2e-b";
const AGENT_A = "agent:e2e:alice";
const AGENT_B = "agent:e2e:bob";
const NAMESPACE = "e2e-test-security";

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

function startDaemon(agentId: string, orgId: string, port: number, dataDir: string): ChildProcess {
  const proc = spawn("npx", [
    "tsx", "src/daemon/server.ts",
    "--agent-id", agentId,
    "--org-id", orgId,
    "--namespace", NAMESPACE,
    "--data-dir", dataDir,
    "--port", String(port),
  ], {
    cwd: "/home/opc/agent-p2p",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENT_P2P_PASSPHRASE: "e2e-test" },
  });

  proc.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) process.stderr.write(`[${agentId}] ${line}\n`);
  });

  return proc;
}

describe("E2E Security Integration", () => {
  before(async () => {
    // Clean up data dirs
    if (existsSync(DATA_A)) rmSync(DATA_A, { recursive: true });
    if (existsSync(DATA_B)) rmSync(DATA_B, { recursive: true });

    // Start both daemons
    procA = startDaemon(AGENT_A, "org:e2e", PORT_A, DATA_A);
    procB = startDaemon(AGENT_B, "org:e2e", PORT_B, DATA_B);

    // Wait for both to be ready
    await Promise.all([
      waitForDaemon(PORT_A),
      waitForDaemon(PORT_B),
    ]);

    // Read API tokens
    tokenA = readFileSync(join(DATA_A, "api-token"), "utf8").trim();
    tokenB = readFileSync(join(DATA_B, "api-token"), "utf8").trim();
  });

  after(() => {
    procA?.kill("SIGTERM");
    procB?.kill("SIGTERM");
    // Clean up
    if (existsSync(DATA_A)) rmSync(DATA_A, { recursive: true });
    if (existsSync(DATA_B)) rmSync(DATA_B, { recursive: true });
  });

  it("both daemons are healthy", async () => {
    const healthA = await (await fetch(`http://127.0.0.1:${PORT_A}/health`)).json() as any;
    const healthB = await (await fetch(`http://127.0.0.1:${PORT_B}/health`)).json() as any;
    assert.equal(healthA.status, "ok");
    assert.equal(healthB.status, "ok");
    assert.equal(healthA.agent_id, AGENT_A);
    assert.equal(healthB.agent_id, AGENT_B);
  });

  it("agents can see their own info", async () => {
    const infoA = await api(PORT_A, tokenA, "GET", "/info");
    const infoB = await api(PORT_B, tokenB, "GET", "/info");
    assert.equal(infoA.agent_id, AGENT_A);
    assert.equal(infoB.agent_id, AGENT_B);
  });

  // --- Token Issuance ---

  let tokenId: string;

  it("Agent A issues a project token", async () => {
    const result = await api(PORT_A, tokenA, "POST", "/token/issue", {
      name: "E2ECoin",
      symbol: "E2E",
      decimals: 18,
      initial_supply: 100000,
    });
    assert.ok(result.token_id, `should have token_id: ${JSON.stringify(result)}`);
    assert.ok(result.token_id.startsWith("local:E2E-"));
    assert.equal(result.name, "E2ECoin");
    assert.equal(result.issuer, AGENT_A);
    tokenId = result.token_id;
  });

  it("Agent A has initial balance", async () => {
    const result = await api(PORT_A, tokenA, "GET", `/wallet/balance?token_id=${encodeURIComponent(tokenId)}`);
    assert.equal(result.balance, 100000);
  });

  it("Agent A can mint more tokens", async () => {
    const result = await api(PORT_A, tokenA, "POST", "/token/mint", {
      token_id: tokenId,
      amount: 50000,
    });
    assert.ok(result.success);

    const balance = await api(PORT_A, tokenA, "GET", `/wallet/balance?token_id=${encodeURIComponent(tokenId)}`);
    assert.equal(balance.balance, 150000);
  });

  it("lists tokens", async () => {
    const result = await api(PORT_A, tokenA, "GET", "/token/list");
    assert.ok(result.tokens.length >= 1);
    assert.equal(result.tokens[0].symbol, "E2E");
  });

  // --- Wallet ---

  it("Agent A can connect external wallet", async () => {
    const result = await api(PORT_A, tokenA, "POST", "/wallet/connect", {
      chain: "ethereum",
      address: "0x1234567890abcdef",
    });
    assert.equal(result.chain, "ethereum");
    assert.equal(result.address, "0x1234567890abcdef");
  });

  // --- Offer & Escrow ---

  it("Agent A creates a payment offer", async () => {
    const result = await api(PORT_A, tokenA, "POST", "/offer/create", {
      task_id: "task_e2e_test_1",
      to: AGENT_B,
      token_id: tokenId,
      amount: 1000,
    });
    assert.ok(result.offer_id);
    assert.equal(result.status, "offered");
    assert.equal(result.amount, 1000);
  });

  it("Agent A locks escrow", async () => {
    const offers = await api(PORT_A, tokenA, "GET", "/offer/list");
    const offer = offers.offers[0];

    const result = await api(PORT_A, tokenA, "POST", "/escrow/lock", {
      offer_id: offer.offer_id,
    });
    assert.ok(result.success, `lock failed: ${JSON.stringify(result)}`);
    assert.ok(result.escrow);
    assert.equal(result.escrow.status, "locked");

    // Balance decreased
    const balance = await api(PORT_A, tokenA, "GET", `/wallet/balance?token_id=${encodeURIComponent(tokenId)}`);
    assert.equal(balance.balance, 149000); // 150000 - 1000
  });

  it("Agent A releases escrow (simulating verified completion)", async () => {
    const escrows = await api(PORT_A, tokenA, "GET", "/escrow/list");
    const escrow = escrows.escrows[0];

    const result = await api(PORT_A, tokenA, "POST", "/escrow/release", {
      escrow_id: escrow.escrow_id,
      proof_id: "proof_e2e_test_1",
    });
    assert.ok(result.success, `release failed: ${JSON.stringify(result)}`);

    // Check B's balance increased (B's wallet is on A's daemon in this test)
    const balanceB = await api(PORT_A, tokenA, "GET", `/wallet/balance?token_id=${encodeURIComponent(tokenId)}&agent_id=${AGENT_B}`);
    assert.equal(balanceB.balance, 1000);
  });

  // --- Verification ---

  it("creates and retrieves a challenge", async () => {
    const challenge = await api(PORT_A, tokenA, "POST", "/verification/challenge", {
      task_id: "task_verify_test",
    });
    assert.equal(challenge.task_id, "task_verify_test");
    assert.ok(challenge.nonce);
    assert.ok(challenge.expires_at);
  });

  it("creates an execution proof", async () => {
    const proof = await api(PORT_A, tokenA, "POST", "/verification/prove", {
      task_id: "task_prove_test",
      input: { data: "hello" },
      output: { result: "world" },
    });
    assert.ok(proof.proof_id);
    assert.ok(proof.input_hash.startsWith("sha256:"));
    assert.ok(proof.output_hash.startsWith("sha256:"));
    assert.equal(proof.signature.algorithm, "Ed25519");
  });

  it("retrieves proof by task_id", async () => {
    const result = await api(PORT_A, tokenA, "GET", "/verification/proof?task_id=task_prove_test");
    assert.ok(result.proof_id);
    assert.equal(result.task_id, "task_prove_test");
  });

  // --- Reputation ---

  it("starts with reputation records (from escrow release)", async () => {
    const result = await api(PORT_A, tokenA, "GET", "/reputation");
    assert.ok(Array.isArray(result.records));
  });

  it("can get and set reputation policy", async () => {
    const policy = await api(PORT_A, tokenA, "GET", "/reputation/policy");
    assert.ok(policy.demote_threshold);
    assert.ok(policy.promote_threshold);

    const updated = await api(PORT_A, tokenA, "POST", "/reputation/policy", {
      demote_threshold: 0.2,
      promote_threshold: 0.9,
    });
    assert.equal(updated.demote_threshold, 0.2);
    assert.equal(updated.promote_threshold, 0.9);
  });

  // --- Ledger ---

  it("ledger records all transactions", async () => {
    const result = await api(PORT_A, tokenA, "GET", "/ledger");
    assert.ok(result.entries.length > 0);
    // Should have mint entries at minimum
    const types = result.entries.map((e: any) => e.entry_type);
    assert.ok(types.includes("mint"), `should have mint entry, got: ${types}`);
  });

  it("ledger hash chain is valid", async () => {
    const result = await api(PORT_A, tokenA, "GET", "/ledger/verify");
    assert.ok(result.valid, "ledger hash chain should be valid");
  });

  // --- Escrow dispute + refund flow ---

  it("dispute + refund flow works", async () => {
    // Create new offer
    const offer = await api(PORT_A, tokenA, "POST", "/offer/create", {
      task_id: "task_dispute_test",
      to: AGENT_B,
      token_id: tokenId,
      amount: 500,
    });

    // Lock
    const lock = await api(PORT_A, tokenA, "POST", "/escrow/lock", {
      offer_id: offer.offer_id,
    });
    assert.ok(lock.success);
    const escrowId = lock.escrow.escrow_id;

    const balanceBefore = (await api(PORT_A, tokenA, "GET", `/wallet/balance?token_id=${encodeURIComponent(tokenId)}`)).balance;

    // Dispute
    const dispute = await api(PORT_A, tokenA, "POST", "/escrow/dispute", {
      escrow_id: escrowId,
    });
    assert.ok(dispute.success);

    // Refund
    const refund = await api(PORT_A, tokenA, "POST", "/escrow/refund", {
      escrow_id: escrowId,
    });
    assert.ok(refund.success);

    // Balance restored
    const balanceAfter = (await api(PORT_A, tokenA, "GET", `/wallet/balance?token_id=${encodeURIComponent(tokenId)}`)).balance;
    assert.equal(balanceAfter, balanceBefore + 500);
  });

  // --- Auth ---

  it("rejects requests without auth token", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT_A}/info`);
    assert.equal(res.status, 401);
  });

  it("rejects requests with wrong auth token", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT_A}/info`, {
      headers: { Authorization: "Bearer wrongtoken" },
    });
    assert.equal(res.status, 401);
  });
});
