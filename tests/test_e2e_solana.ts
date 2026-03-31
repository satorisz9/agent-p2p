/**
 * E2E Solana On-Chain Tests (devnet)
 *
 * Tests:
 *   1. Daemon starts with Solana wallet derived from agent key
 *   2. Airdrop SOL on devnet (skips if rate-limited)
 *   3. Create SPL token on-chain
 *   4. Mint additional tokens
 *   5. Transfer tokens to another wallet
 *   6. Balance queries (SOL and SPL)
 *   7. Explorer URLs are valid
 *
 * Requires: network access to Solana devnet + SOL for gas.
 * If airdrop is rate-limited, fund the wallet manually first:
 *   https://faucet.solana.com
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "child_process";
import { readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";

const PORT_A = 7730;
const PORT_B = 7731;
const DATA_A = "/tmp/agent-p2p-e2e-sol-a";
const DATA_B = "/tmp/agent-p2p-e2e-sol-b";
const AGENT_A = "agent:sol:alice";
const AGENT_B = "agent:sol:bob";
const NAMESPACE = "e2e-test-solana";

// Minimum SOL needed for all operations (token creation, minting, transfers)
const MIN_SOL_REQUIRED = 0.1;

let procA: ChildProcess;
let procB: ChildProcess;
let tokenA: string;
let tokenB: string;

// Shared state across tests
let aliceWalletAddress = "";
let bobWalletAddress = "";
let mintAddress = "";
let hasFunding = false;

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

function startDaemon(agentId: string, port: number, dataDir: string): ChildProcess {
  const proc = spawn("npx", [
    "tsx", "src/daemon/server.ts",
    "--agent-id", agentId,
    "--org-id", "org:sol",
    "--namespace", NAMESPACE,
    "--data-dir", dataDir,
    "--port", String(port),
    "--solana-network", "devnet",
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENT_P2P_PASSPHRASE: "e2e-solana-test" },
  });

  proc.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) process.stderr.write(`[${agentId}] ${line}\n`);
  });

  return proc;
}

describe("Solana On-Chain E2E (devnet)", () => {
  // Don't clean data dirs — persist keys so wallet addresses stay the same
  // (allows manual funding via faucet.solana.com between test runs)
  before(async () => {
    procA = startDaemon(AGENT_A, PORT_A, DATA_A);
    procB = startDaemon(AGENT_B, PORT_B, DATA_B);

    await Promise.all([
      waitForDaemon(PORT_A),
      waitForDaemon(PORT_B),
    ]);

    tokenA = readFileSync(join(DATA_A, "api-token"), "utf8").trim();
    tokenB = readFileSync(join(DATA_B, "api-token"), "utf8").trim();
  });

  after(() => {
    procA?.kill("SIGTERM");
    procB?.kill("SIGTERM");
    // Don't delete data dirs — preserve keys for re-runs
  });

  it("GET /solana/wallet returns wallet address and devnet info", async () => {
    const wallet = await api(PORT_A, tokenA, "GET", "/solana/wallet");
    assert.ok(wallet.address, "Should have wallet address");
    assert.equal(wallet.network, "devnet");
    assert.ok(wallet.explorer_url.includes("solscan.io"));
    assert.ok(wallet.explorer_url.includes("devnet"));
    aliceWalletAddress = wallet.address;
    console.log(`  Alice: ${aliceWalletAddress}`);
    console.log(`  Explorer: ${wallet.explorer_url}`);

    const walletB = await api(PORT_B, tokenB, "GET", "/solana/wallet");
    bobWalletAddress = walletB.address;
    console.log(`  Bob: ${bobWalletAddress}`);

    assert.notEqual(aliceWalletAddress, bobWalletAddress);
  });

  it("fund wallets via airdrop (skip if rate-limited)", async () => {
    // Check current balances
    const walletA = await api(PORT_A, tokenA, "GET", "/solana/wallet");
    const walletB = await api(PORT_B, tokenB, "GET", "/solana/wallet");

    console.log(`  Alice SOL: ${walletA.sol_balance}`);
    console.log(`  Bob SOL: ${walletB.sol_balance}`);

    if (walletA.sol_balance >= MIN_SOL_REQUIRED && walletB.sol_balance >= MIN_SOL_REQUIRED) {
      console.log(`  Both wallets already funded — skipping airdrop`);
      hasFunding = true;
      return;
    }

    // Try airdrop for Alice
    if (walletA.sol_balance < MIN_SOL_REQUIRED) {
      const result = await api(PORT_A, tokenA, "POST", "/solana/airdrop", { amount: 2 });
      if (result.success) {
        console.log(`  Alice airdrop OK: ${result.explorer_url}`);
        await sleep(2000);
      } else {
        console.log(`  Alice airdrop rate-limited: ${result.error}`);
        console.log(`  Fund manually: https://faucet.solana.com`);
        console.log(`  Address: ${aliceWalletAddress}`);
        return; // Skip — can't proceed without funds
      }
    }

    // Try airdrop for Bob
    if (walletB.sol_balance < MIN_SOL_REQUIRED) {
      await sleep(3000); // Avoid back-to-back rate limits
      const result = await api(PORT_B, tokenB, "POST", "/solana/airdrop", { amount: 1 });
      if (result.success) {
        console.log(`  Bob airdrop OK: ${result.explorer_url}`);
      } else {
        console.log(`  Bob airdrop rate-limited — Alice will pay for Bob's ATA`);
      }
    }

    // Re-check Alice balance
    const walletA2 = await api(PORT_A, tokenA, "GET", "/solana/wallet");
    hasFunding = walletA2.sol_balance >= MIN_SOL_REQUIRED;
    if (!hasFunding) {
      console.log(`  SKIP: Insufficient SOL. Fund wallets via https://faucet.solana.com`);
    }
  });

  it("POST /solana/token/create creates SPL token on-chain", async () => {
    if (!hasFunding) {
      console.log(`  SKIP: No SOL funding`);
      return;
    }

    const result = await api(PORT_A, tokenA, "POST", "/solana/token/create", {
      name: "TestCoin",
      symbol: "TEST",
      decimals: 6,
      initial_supply: 1000000,
    });
    assert.ok(result.success, `Token creation failed: ${JSON.stringify(result)}`);
    assert.ok(result.mint_address);
    assert.ok(result.token_id.startsWith("sol:"));
    mintAddress = result.mint_address;
    console.log(`  Mint: ${mintAddress}`);
    console.log(`  Explorer: ${result.explorer_url}`);

    // Token registered in local economic state
    const tokens = await api(PORT_A, tokenA, "GET", "/token/list");
    const found = tokens.tokens.find((t: any) => t.contract_address === mintAddress);
    assert.ok(found, "Token should be registered locally");
    assert.equal(found.chain, "solana");

    await sleep(1000);
  });

  it("GET /solana/token/info returns on-chain metadata", async () => {
    if (!mintAddress) { console.log("  SKIP: No mint"); return; }

    const info = await api(PORT_A, tokenA, "GET", `/solana/token/info?mint_address=${mintAddress}`);
    assert.equal(info.decimals, 6);
    assert.equal(info.mint_authority, aliceWalletAddress);
    console.log(`  Supply: ${info.supply} raw units`);
    console.log(`  Explorer: ${info.explorer_url}`);
  });

  it("GET /solana/token/balance returns on-chain balance", async () => {
    if (!mintAddress) { console.log("  SKIP: No mint"); return; }

    const balance = await api(PORT_A, tokenA, "GET",
      `/solana/token/balance?mint_address=${mintAddress}`
    );
    assert.equal(balance.amount, 1000000);
    assert.equal(balance.decimals, 6);
    console.log(`  Alice: ${balance.amount} TEST`);
  });

  it("POST /solana/token/mint adds more on-chain", async () => {
    if (!mintAddress) { console.log("  SKIP: No mint"); return; }

    const result = await api(PORT_A, tokenA, "POST", "/solana/token/mint", {
      mint_address: mintAddress,
      amount: 500000,
      decimals: 6,
    });
    assert.ok(result.success, `Mint failed: ${JSON.stringify(result)}`);
    console.log(`  Mint tx: ${result.explorer_url}`);

    await sleep(1000);

    const balance = await api(PORT_A, tokenA, "GET",
      `/solana/token/balance?mint_address=${mintAddress}`
    );
    assert.equal(balance.amount, 1500000, "1M + 500K = 1.5M");
  });

  it("POST /solana/token/transfer sends on-chain", async () => {
    if (!mintAddress) { console.log("  SKIP: No mint"); return; }

    const result = await api(PORT_A, tokenA, "POST", "/solana/token/transfer", {
      mint_address: mintAddress,
      to_address: bobWalletAddress,
      amount: 250000,
      decimals: 6,
    });
    assert.ok(result.success, `Transfer failed: ${JSON.stringify(result)}`);
    console.log(`  Transfer tx: ${result.explorer_url}`);

    await sleep(1500);

    // Alice balance decreased
    const aliceBal = await api(PORT_A, tokenA, "GET",
      `/solana/token/balance?mint_address=${mintAddress}`
    );
    assert.equal(aliceBal.amount, 1250000, "1.5M - 250K = 1.25M");

    // Bob balance on-chain
    const bobBal = await api(PORT_B, tokenB, "GET",
      `/solana/token/balance?mint_address=${mintAddress}&owner_address=${bobWalletAddress}`
    );
    assert.equal(bobBal.amount, 250000, "Bob: 250K on-chain");
    console.log(`  Bob on-chain: ${bobBal.amount} TEST`);
  });

  it("insufficient balance transfer fails gracefully", async () => {
    if (!mintAddress) { console.log("  SKIP: No mint"); return; }

    const result = await api(PORT_A, tokenA, "POST", "/solana/token/transfer", {
      mint_address: mintAddress,
      to_address: bobWalletAddress,
      amount: 99000000, // way more than Alice has
      decimals: 6,
    });
    assert.ok(!result.success);
    assert.ok(result.error);
    console.log(`  Expected error: ${result.error.substring(0, 80)}`);
  });

  it("explorer URLs all point to devnet", async () => {
    const wallet = await api(PORT_A, tokenA, "GET", "/solana/wallet");
    assert.ok(wallet.explorer_url.includes("cluster=devnet"));

    if (mintAddress) {
      const info = await api(PORT_A, tokenA, "GET", `/solana/token/info?mint_address=${mintAddress}`);
      assert.ok(info.explorer_url.includes("cluster=devnet"));
      console.log(`\n  Token: ${info.explorer_url}`);
    }
    console.log(`  Alice: ${wallet.explorer_url}`);
  });
});
