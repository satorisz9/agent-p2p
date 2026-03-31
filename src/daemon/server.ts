#!/usr/bin/env node

/**
 * P2P Agent Daemon — long-running process independent of Claude Code sessions.
 *
 * Responsibilities:
 *   - Maintains Hyperswarm P2P connections
 *   - Manages agent state and message flows
 *   - Queues outbound messages for offline peers
 *   - Retries delivery on reconnection
 *   - Exposes a local HTTP API on localhost for MCP server to connect to
 *
 * Lifecycle:
 *   - Started via systemd or manually
 *   - Persists state to disk
 *   - Survives Claude Code session restarts
 *
 * Usage:
 *   node dist/daemon/server.js \
 *     --agent-id agent:mindaxis:worker-a \
 *     --org-id org:mindaxis \
 *     --namespace marketplace-2026 \
 *     --data-dir ~/.agent-p2p/worker-a \
 *     --port 7700
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { P2PAgent } from "../agent/core";
import { BillingPlugin } from "../agent/billing";
import { DiscoveryClient, type ConnectionRequest } from "../lib/discovery/client";
import { InviteManager } from "../lib/invite/manager";
import { AuctionManager } from "../lib/marketplace/auction";
import { TaskManager } from "../lib/task/manager";
import { TaskPlanner, type Plan } from "../lib/task/planner";
import { ReputationManager } from "../lib/reputation/manager";
import { ExecutionVerifier } from "../lib/verification/prover";
import { EconomicManager } from "../lib/economic/wallet";
import { ProfileManager } from "../lib/matching/profile";
import { WorkspaceIntrospector } from "../lib/matching/introspect";
import { TaskPolicyManager } from "../lib/security/policy";
import { SolanaClient } from "../lib/chain/solana";
import type {
  AgentId,
  AuctionRecord,
  AuctionStatus,
  ConnectionMode,
  ExecutionProof,
  Heartbeat,
  InvoiceIssuePayload,
  OrgId,
  TaskAward,
  TaskBid,
  TaskBroadcast,
} from "../types/protocol";

// --- Parse CLI args ---

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string): string => {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length) {
      if (fallback !== undefined) return fallback;
      console.error(`Missing required argument: ${flag}`);
      process.exit(1);
    }
    return args[idx + 1];
  };
  const has = (flag: string): boolean => args.includes(flag);

  return {
    agentId: get("--agent-id") as AgentId,
    orgId: get("--org-id") as OrgId,
    namespace: get("--namespace"),
    dataDir: get("--data-dir"),
    port: parseInt(get("--port", "7700"), 10),
    discoveryUrl: get("--discovery-url", ""),
    description: get("--description", ""),
    enableBilling: has("--enable-billing"),
    solanaNetwork: get("--solana-network", "devnet") as "devnet" | "mainnet-beta",
    solanaRpcUrl: get("--solana-rpc-url", ""),
  };
}

// --- HTTP API for MCP proxy ---

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// --- API Token management ---

function loadOrCreateApiToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const tokenFile = join(dataDir, "api-token");

  if (existsSync(tokenFile)) {
    const token = readFileSync(tokenFile, "utf8").trim();
    if (token.length > 0) return token;
  }

  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenFile, token, { mode: 0o600 });
  return token;
}

function checkBearerAuth(req: IncomingMessage, expectedToken: string): boolean {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return false;
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return false;
  return parts[1] === expectedToken;
}

type SwarmTaskPeer = {
  agentId?: AgentId;
  connected: boolean;
  verified?: boolean;
};

type SwarmTaskApi = {
  broadcastTask?: (broadcast: TaskBroadcast) => number;
  getConnectedPeers?: () => SwarmTaskPeer[];
  sendTaskMessage: (targetAgentId: AgentId, type: string, payload: unknown) => boolean;
};

// --- Economic state persistence ---

const ECONOMIC_STATE_FILE = "economic-state.json";

function loadEconomicState(dataDir: string, economic: EconomicManager): void {
  const file = join(dataDir, ECONOMIC_STATE_FILE);
  if (!existsSync(file)) return;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    economic.load(data);
    const tokenCount = Object.keys(data.tokens || {}).length;
    const walletCount = Object.keys(data.wallets || {}).length;
    console.error(`[Economic] Loaded state: ${tokenCount} tokens, ${walletCount} wallets, ${(data.ledger || []).length} ledger entries`);
  } catch (err) {
    console.error(`[Economic] WARNING: Failed to load state from ${file}: ${(err as Error).message}`);
  }
}

function saveEconomicState(dataDir: string, economic: EconomicManager): void {
  const file = join(dataDir, ECONOMIC_STATE_FILE);
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, JSON.stringify(economic.serialize(), null, 2));
  } catch (err) {
    console.error(`[Economic] WARNING: Failed to save state to ${file}: ${(err as Error).message}`);
  }
}

function broadcastAuctionTask(agent: P2PAgent, broadcast: TaskBroadcast): number {
  const swarm = (agent as any).swarm as SwarmTaskApi;
  if (typeof swarm.broadcastTask === "function") {
    return swarm.broadcastTask(broadcast);
  }

  const peers = typeof swarm.getConnectedPeers === "function" ? swarm.getConnectedPeers() : [];
  let sent = 0;
  for (const peer of peers) {
    if (!peer.connected || peer.verified === false || !peer.agentId) continue;
    if (swarm.sendTaskMessage(peer.agentId, "task_broadcast", broadcast)) {
      sent++;
    }
  }
  return sent;
}

function buildAuctionAward(auction: AuctionRecord): TaskAward | null {
  if (!auction.winner_bid_id || !auction.winner_agent_id || !auction.awarded_at) {
    return null;
  }

  const winningBid = auction.bids.find((bid) => bid.bid_id === auction.winner_bid_id);
  if (!winningBid) return null;

  return {
    task_id: auction.task_id,
    bid_id: auction.winner_bid_id,
    awarded_to: auction.winner_agent_id,
    agreed_price: winningBid.price,
    awarded_at: auction.awarded_at,
  };
}

function serializeAuction(auction: AuctionRecord, auctionOrigins: Map<string, AgentId>) {
  return {
    ...auction,
    issuer_agent_id: auctionOrigins.get(auction.task_id) ?? null,
  };
}

function createDaemonApi(
  agent: P2PAgent,
  port: number,
  inviteManager: InviteManager,
  apiToken: string,
  taskManager: TaskManager,
  planner: TaskPlanner,
  reputation: ReputationManager,
  verifier: ExecutionVerifier,
  economic: EconomicManager,
  auction: AuctionManager,
  auctionOrigins: Map<string, AgentId>,
  billing: BillingPlugin | null,
  profileManager: ProfileManager,
  taskPolicy: TaskPolicyManager,
  dataDir: string,
  solana: SolanaClient,
  solanaKeypair: import("@solana/web3.js").Keypair
) {
  const server = createServer(async (req, res) => {
    // Only accept from localhost
    const remoteAddr = req.socket.remoteAddress;
    if (remoteAddr !== "127.0.0.1" && remoteAddr !== "::1" && remoteAddr !== "::ffff:127.0.0.1") {
      json(res, 403, { error: "Daemon API is localhost-only" });
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;

    // Allow /health without auth (for monitoring)
    if (req.method === "GET" && path === "/health") {
      json(res, 200, {
        status: "ok",
        agent_id: agent.getAgentInfo().agent_id,
        uptime: process.uptime(),
        billing_enabled: billing !== null,
      });
      return;
    }

    // Require Bearer token for all other endpoints
    if (!checkBearerAuth(req, apiToken)) {
      json(res, 401, { error: "Unauthorized — include Authorization: Bearer <token> header" });
      return;
    }

    try {
      // --- Routes ---

      if (req.method === "GET" && path === "/info") {
        json(res, 200, {
          ...agent.getAgentInfo(),
          billing_enabled: billing !== null,
        });
        return;
      }

      if (req.method === "GET" && path === "/peers") {
        json(res, 200, agent.getConnectedPeers());
        return;
      }

      // --- Billing (legacy, optional plugin) routes ---

      if (path === "/audit" || path === "/invoices" || path.startsWith("/invoices/")) {
        if (!billing) {
          json(res, 404, { error: "Billing plugin is disabled" });
          return;
        }

        if (req.method === "GET" && path === "/invoices") {
          const invoiceId = url.searchParams.get("invoice_id");
          if (invoiceId) {
            const invoice = billing.getInvoice(invoiceId);
            const audit = billing.getAuditLog(invoiceId);
            json(res, invoice ? 200 : 404, { invoice, audit });
          } else {
            json(res, 200, billing.listInvoices());
          }
          return;
        }

        if (req.method === "POST" && path === "/invoices/issue") {
          const body = JSON.parse(await readBody(req));
          const result = billing.issueInvoice(
            body.target_agent_id as AgentId,
            body.invoice as InvoiceIssuePayload
          );
          json(res, result.success ? 200 : 422, result);
          return;
        }

        if (req.method === "POST" && path === "/invoices/accept") {
          const body = JSON.parse(await readBody(req));
          const result = billing.acceptInvoice(
            body.invoice_id,
            body.scheduled_payment_date
          );
          json(res, result.success ? 200 : 422, result);
          return;
        }

        if (req.method === "POST" && path === "/invoices/reject") {
          const body = JSON.parse(await readBody(req));
          const result = billing.rejectInvoice(
            body.invoice_id,
            body.reason_code,
            body.reason_message
          );
          json(res, result.success ? 200 : 422, result);
          return;
        }

        if (req.method === "GET" && path === "/audit") {
          const invoiceId = url.searchParams.get("invoice_id") ?? undefined;
          json(res, 200, billing.getAuditLog(invoiceId));
          return;
        }
      }

      if (req.method === "GET" && path === "/inbox") {
        json(res, 200, agent.getInbox());
        return;
      }

      if (req.method === "POST" && path === "/inbox/process") {
        json(res, 200, agent.processNextInboxMessage());
        return;
      }

      if (req.method === "POST" && path === "/file/send") {
        const body = JSON.parse(await readBody(req));
        const result = agent.sendFile(
          body.target_agent_id as AgentId,
          body.file_path
        );
        json(res, result.success ? 200 : 422, result);
        return;
      }

      if (req.method === "GET" && path === "/file/received") {
        const { readdirSync, statSync } = await import("fs");
        const receivedDir = require("path").join(agent.getAgentInfo().agent_id.replace(/:/g, "_"), "received");
        const dataDir = (agent as any).config?.dataDir || "";
        const dir = require("path").join(dataDir, "received");
        try {
          const files = readdirSync(dir).map(f => ({
            name: f,
            size: statSync(require("path").join(dir, f)).size,
          }));
          json(res, 200, { files, directory: dir });
        } catch {
          json(res, 200, { files: [], directory: dir });
        }
        return;
      }

      // --- Invite routes ---

      if (req.method === "POST" && path === "/invite/create") {
        const body = await readBody(req);
        const parsed = body ? JSON.parse(body) : {};
        const expiresIn = Math.min(Math.max(parsed.expires_in || 600, 60), 86400);
        const mode = parsed.mode || "restricted";
        const invite = await inviteManager.create(expiresIn, mode);
        json(res, 200, invite);
        return;
      }

      if (req.method === "POST" && path === "/invite/accept") {
        const body = JSON.parse(await readBody(req));
        if (!body.code) { json(res, 400, { error: "code required" }); return; }
        const result = await inviteManager.accept(body.code, body.mode || "restricted");
        json(res, result.success ? 200 : 400, result);
        return;
      }

      if (req.method === "GET" && path === "/invite/pending") {
        json(res, 200, { invites: inviteManager.listPending() });
        return;
      }

      // --- Task routes ---

      if (req.method === "POST" && path === "/task/request") {
        const body = JSON.parse(await readBody(req));
        const targetId = body.target_agent_id as AgentId;
        const perm = taskManager.checkPermission(targetId, "task", "request");
        if (!perm.allowed) { json(res, 403, { error: "Not permitted to request tasks from this peer" }); return; }

        const task = taskManager.createTask(targetId, {
          type: body.type || "generic",
          description: body.description || "",
          input: body.input || {},
          timeout_ms: body.timeout_ms,
          priority: body.priority,
        });

        const sent = (agent as any).swarm.sendTaskMessage(targetId, "task_request", task.request);
        if (!sent) { json(res, 422, { error: "Peer not connected", task }); return; }

        json(res, 200, { task, needs_approval: perm.needsApproval });
        return;
      }

      if (req.method === "GET" && path === "/task/list") {
        const status = url.searchParams.get("status") || undefined;
        json(res, 200, { tasks: taskManager.listTasks(status as any) });
        return;
      }

      if (req.method === "GET" && path.startsWith("/task/") && path.split("/").length === 3) {
        const taskId = path.split("/")[2];
        const task = taskManager.getTask(taskId);
        json(res, task ? 200 : 404, task || { error: "Task not found" });
        return;
      }

      if (req.method === "POST" && path === "/task/respond") {
        const body = JSON.parse(await readBody(req));
        const { task_id, action } = body; // action: accept | reject | complete | fail | cancel
        const task = taskManager.getTask(task_id);
        if (!task) { json(res, 404, { error: "Task not found" }); return; }

        if (action === "accept") {
          taskManager.updateTaskStatus(task_id, "accepted");
          (agent as any).swarm.sendTaskMessage(task.from, "task_accept", { task_id });
        } else if (action === "reject") {
          taskManager.updateTaskStatus(task_id, "cancelled");
          (agent as any).swarm.sendTaskMessage(task.from, "task_reject", { task_id, reason: body.reason || "" });
        } else if (action === "complete") {
          const result = { task_id, status: "completed" as const, output: body.output || {}, duration_ms: Date.now() - task.created_at };
          taskManager.updateTaskStatus(task_id, "completed", result);
          (agent as any).swarm.sendTaskMessage(task.from, "task_result", result);
        } else if (action === "fail") {
          taskManager.updateTaskStatus(task_id, "failed");
          (agent as any).swarm.sendTaskMessage(task.from, "task_error", { task_id, error_code: "TASK_FAILED", message: body.error || "Failed", retryable: body.retryable ?? false });
        } else if (action === "cancel") {
          taskManager.updateTaskStatus(task_id, "cancelled");
          (agent as any).swarm.sendTaskMessage(task.to === agent.getAgentInfo().agent_id ? task.from : task.to, "task_cancel", { task_id, reason: body.reason });
        }
        json(res, 200, taskManager.getTask(task_id));
        return;
      }

      // --- Task Queue routes ---

      if (req.method === "POST" && path === "/queue/enqueue") {
        const body = JSON.parse(await readBody(req));
        const task = taskManager.enqueue({
          type: body.type || "generic",
          description: body.description || "",
          input: body.input || {},
          timeout_ms: body.timeout_ms,
          priority: body.priority,
        }, body.assign_to);
        json(res, 200, task);
        return;
      }

      if (req.method === "GET" && path === "/queue") {
        json(res, 200, { length: taskManager.queueLength(), tasks: taskManager.listTasks("pending") });
        return;
      }

      if (req.method === "POST" && path === "/queue/dequeue") {
        const body = await readBody(req);
        const parsed = body ? JSON.parse(body) : {};
        const task = taskManager.dequeue(agent.getAgentInfo().agent_id, parsed.capabilities);
        json(res, task ? 200 : 204, task || { message: "No tasks available" });
        return;
      }

      if (req.method === "POST" && path === "/worker/start") {
        const body = await readBody(req);
        const parsed = body ? JSON.parse(body) : {};
        const intervalMs = parsed.interval_ms || 30000;
        const targetPeers = taskManager.listPeers().map(p => p.agent_id);

        taskManager.startWorker(
          intervalMs,
          async () => {
            // Poll all connected peers for tasks
            for (const peerId of targetPeers) {
              (agent as any).swarm.sendTaskMessage(peerId, "task_poll", {
                capabilities: taskManager.buildHeartbeat().capabilities,
              });
            }
            // Wait a bit for response
            return new Promise<any>((resolve) => {
              const timer = setTimeout(() => resolve(null), 5000);
              taskManager.once("worker:task_received", ({ task }: any) => {
                clearTimeout(timer);
                resolve(task);
              });
            });
          },
          async (task) => {
            // Emit event for external handler (MCP server / Claude Code)
            taskManager.emit("worker:execute", task);
            // Default: return success with empty output
            // Real execution would be handled by the task handler
            return { output: { message: "Task received, awaiting external execution" } };
          }
        );
        json(res, 200, { status: "worker started", interval_ms: intervalMs, polling_peers: targetPeers });
        return;
      }

      if (req.method === "POST" && path === "/worker/stop") {
        taskManager.stopWorker();
        json(res, 200, { status: "worker stopped" });
        return;
      }

      // --- Plan routes ---

      if (req.method === "POST" && path === "/plan/load") {
        const body = JSON.parse(await readBody(req)) as Plan;
        const state = planner.loadPlan(body);
        json(res, 200, state);
        return;
      }

      if (req.method === "POST" && path.match(/^\/plan\/([^/]+)\/start$/)) {
        const planId = path.split("/")[2];
        try {
          planner.start(planId);
          json(res, 200, planner.getPlan(planId));
        } catch (e) {
          json(res, 404, { error: (e as Error).message });
        }
        return;
      }

      if (req.method === "GET" && path === "/plan/list") {
        json(res, 200, { plans: planner.listPlans() });
        return;
      }

      if (req.method === "GET" && path.match(/^\/plan\/([^/]+)$/)) {
        const planId = path.split("/")[2];
        const state = planner.getPlan(planId);
        json(res, state ? 200 : 404, state || { error: "Plan not found" });
        return;
      }

      // --- Peer permission routes ---

      if (req.method === "GET" && path === "/peers/config") {
        json(res, 200, { peers: taskManager.listPeers() });
        return;
      }

      if (req.method === "POST" && path === "/peers/config") {
        const body = JSON.parse(await readBody(req));
        const config = taskManager.setPeerConfig(
          body.agent_id as AgentId,
          (body.mode || "restricted") as ConnectionMode,
          body.shared_namespace
        );
        json(res, 200, config);
        return;
      }

      // --- Heartbeat ---

      if (req.method === "GET" && path === "/heartbeat") {
        json(res, 200, taskManager.buildHeartbeat());
        return;
      }

      // ============================================================
      // Reputation routes
      // ============================================================

      if (req.method === "GET" && path === "/reputation") {
        const agentIdParam = url.searchParams.get("agent_id") as AgentId | null;
        if (agentIdParam) {
          const record = reputation.getRecord(agentIdParam);
          json(res, record ? 200 : 404, record || { error: "No reputation record" });
        } else {
          json(res, 200, { records: reputation.listRecords() });
        }
        return;
      }

      if (req.method === "GET" && path === "/reputation/policy") {
        json(res, 200, reputation.getPolicy());
        return;
      }

      if (req.method === "POST" && path === "/reputation/policy") {
        const body = JSON.parse(await readBody(req));
        reputation.setPolicy(body);
        json(res, 200, reputation.getPolicy());
        return;
      }

      // ============================================================
      // Execution Verification routes
      // ============================================================

      if (req.method === "POST" && path === "/verification/challenge") {
        const body = JSON.parse(await readBody(req));
        const challenge = verifier.createChallenge(body.task_id, body.ttl_ms);
        json(res, 200, challenge);
        return;
      }

      if (req.method === "POST" && path === "/verification/prove") {
        const body = JSON.parse(await readBody(req));
        const privateKey = (await import("../lib/crypto/keys")).fromBase64(agent.getPrivateKey());
        const keyId = (agent as any).state?.keyId || "unknown";
        const proof = verifier.createProof(
          body.task_id,
          body.input,
          body.output,
          privateKey,
          keyId,
          body.challenge
        );
        json(res, 200, proof);
        return;
      }

      if (req.method === "POST" && path === "/verification/verify") {
        const body = JSON.parse(await readBody(req));
        const proof = body.proof as ExecutionProof;
        const workerPubKey = (await import("../lib/crypto/keys")).fromBase64(body.worker_public_key);
        const result = verifier.verifyProof(proof, body.expected_input, body.received_output, workerPubKey);
        // Update reputation based on verification
        if (proof.signature?.key_id) {
          const workerAgentId = body.worker_agent_id as AgentId;
          if (workerAgentId) {
            if (result.valid) {
              reputation.recordVerifiedProof(workerAgentId);
            }
          }
        }
        json(res, 200, result);
        return;
      }

      if (req.method === "GET" && path === "/verification/proof") {
        const taskId = url.searchParams.get("task_id");
        if (taskId) {
          const proof = verifier.getProof(taskId);
          json(res, proof ? 200 : 404, proof || { error: "No proof found" });
        } else {
          json(res, 200, { proofs: verifier.listProofs() });
        }
        return;
      }

      // ============================================================
      // Economic routes — Tokens
      // ============================================================

      if (req.method === "POST" && path === "/token/issue") {
        const body = JSON.parse(await readBody(req));
        const privateKey = (await import("../lib/crypto/keys")).fromBase64(agent.getPrivateKey());
        const keyId = (agent as any).state?.keyId || "unknown";
        const token = economic.issueToken(
          body.name, body.symbol, body.decimals || 18,
          body.initial_supply || 0, privateKey, keyId
        );
        saveEconomicState(dataDir, economic);
        json(res, 200, token);
        return;
      }

      if (req.method === "POST" && path === "/token/register") {
        const body = JSON.parse(await readBody(req));
        const token = economic.registerExternalToken(
          body.token_id, body.name, body.symbol,
          body.decimals || 18, body.chain, body.contract_address
        );
        saveEconomicState(dataDir, economic);
        json(res, 200, token);
        return;
      }

      if (req.method === "GET" && path === "/token/list") {
        json(res, 200, { tokens: economic.listTokens() });
        return;
      }

      if (req.method === "POST" && path === "/token/mint") {
        const body = JSON.parse(await readBody(req));
        const privateKey = (await import("../lib/crypto/keys")).fromBase64(agent.getPrivateKey());
        const keyId = (agent as any).state?.keyId || "unknown";
        const result = economic.mint(body.token_id, body.amount, privateKey, keyId);
        if (result.success) saveEconomicState(dataDir, economic);
        json(res, result.success ? 200 : 422, result);
        return;
      }

      if (req.method === "POST" && path === "/token/transfer") {
        const body = JSON.parse(await readBody(req));
        const privateKey = (await import("../lib/crypto/keys")).fromBase64(agent.getPrivateKey());
        const keyId = (agent as any).state?.keyId || "unknown";
        const myAgentId = agent.getAgentInfo().agent_id;
        const toAgentId = body.to as AgentId;
        const result = economic.transfer(toAgentId, body.token_id, body.amount, privateKey, keyId);
        if (result.success) {
          saveEconomicState(dataDir, economic);
          // Notify recipient via P2P so they can credit their local ledger
          const swarm = (agent as any).swarm as SwarmTaskApi;
          const lastEntry = economic.getLedger(1)[0];
          swarm.sendTaskMessage(toAgentId, "token_transfer" as any, {
            from: myAgentId,
            to: toAgentId,
            token_id: body.token_id,
            amount: body.amount,
            ledger_entry: lastEntry,
          });
        }
        json(res, result.success ? 200 : 422, result);
        return;
      }

      // ============================================================
      // Economic routes — Wallet
      // ============================================================

      if (req.method === "GET" && path === "/wallet") {
        const myAgentId = agent.getAgentInfo().agent_id;
        const agentIdParam = url.searchParams.get("agent_id") as AgentId || myAgentId;
        const wallet = economic.getWallet(agentIdParam);
        json(res, wallet ? 200 : 404, wallet || { error: "No wallet" });
        return;
      }

      if (req.method === "POST" && path === "/wallet/connect") {
        const body = JSON.parse(await readBody(req));
        const myAgentId = agent.getAgentInfo().agent_id;
        const wallet = economic.connectWallet(myAgentId, body.chain, body.address);
        json(res, 200, wallet);
        return;
      }

      if (req.method === "GET" && path === "/wallet/balance") {
        const tokenId = url.searchParams.get("token_id");
        const myAgentId = agent.getAgentInfo().agent_id;
        const agentIdParam = url.searchParams.get("agent_id") as AgentId || myAgentId;
        if (!tokenId) { json(res, 400, { error: "token_id required" }); return; }
        json(res, 200, { balance: economic.getBalance(agentIdParam, tokenId) });
        return;
      }

      // ============================================================
      // Economic routes — Offers & Escrow
      // ============================================================

      if (req.method === "POST" && path === "/offer/create") {
        const body = JSON.parse(await readBody(req));
        const offer = economic.createOffer(body.task_id, body.to as AgentId, body.token_id, body.amount);
        saveEconomicState(dataDir, economic);
        json(res, 200, offer);
        return;
      }

      if (req.method === "GET" && path === "/offer/list") {
        json(res, 200, { offers: economic.listOffers() });
        return;
      }

      if (req.method === "POST" && path === "/escrow/lock") {
        const body = JSON.parse(await readBody(req));
        const privateKey = (await import("../lib/crypto/keys")).fromBase64(agent.getPrivateKey());
        const keyId = (agent as any).state?.keyId || "unknown";
        const result = economic.lockEscrow(body.offer_id, privateKey, keyId);
        if (result.success) saveEconomicState(dataDir, economic);
        json(res, result.success ? 200 : 422, result);
        return;
      }

      if (req.method === "POST" && path === "/escrow/release") {
        const body = JSON.parse(await readBody(req));
        const privateKey = (await import("../lib/crypto/keys")).fromBase64(agent.getPrivateKey());
        const keyId = (agent as any).state?.keyId || "unknown";
        const result = economic.releaseEscrow(body.escrow_id, body.proof_id, privateKey, keyId);
        // Update reputation on payment release
        const escrow = economic.getEscrow(body.escrow_id);
        if (result.success && escrow) {
          reputation.recordTaskCompleted(escrow.to, 0, 0);
        }
        if (result.success) saveEconomicState(dataDir, economic);
        json(res, result.success ? 200 : 422, result);
        return;
      }

      if (req.method === "POST" && path === "/escrow/refund") {
        const body = JSON.parse(await readBody(req));
        const privateKey = (await import("../lib/crypto/keys")).fromBase64(agent.getPrivateKey());
        const keyId = (agent as any).state?.keyId || "unknown";
        const result = economic.refundEscrow(body.escrow_id, privateKey, keyId);
        if (result.success) saveEconomicState(dataDir, economic);
        json(res, result.success ? 200 : 422, result);
        return;
      }

      if (req.method === "POST" && path === "/escrow/dispute") {
        const body = JSON.parse(await readBody(req));
        const result = economic.disputeEscrow(body.escrow_id);
        // Record dispute in reputation
        const escrow = economic.getEscrow(body.escrow_id);
        if (escrow) {
          reputation.recordDispute(escrow.to);
        }
        if (result.success) saveEconomicState(dataDir, economic);
        json(res, result.success ? 200 : 422, result);
        return;
      }

      if (req.method === "GET" && path === "/escrow/list") {
        json(res, 200, { escrows: economic.listEscrows() });
        return;
      }

      if (req.method === "GET" && path === "/ledger") {
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);
        json(res, 200, { entries: economic.getLedger(limit) });
        return;
      }

      if (req.method === "GET" && path === "/ledger/verify") {
        json(res, 200, economic.verifyLedgerIntegrity());
        return;
      }

      // ============================================================
      // Solana on-chain routes
      // ============================================================

      if (req.method === "GET" && path === "/solana/wallet") {
        const address = solanaKeypair.publicKey.toBase58();
        try {
          const balance = await solana.getSOLBalance(address);
          json(res, 200, {
            address,
            network: solana.getNetwork(),
            sol_balance: balance / 1e9,
            sol_balance_lamports: balance,
            explorer_url: solana.explorerUrl("address", address),
          });
        } catch (err) {
          json(res, 200, {
            address,
            network: solana.getNetwork(),
            sol_balance: 0,
            explorer_url: solana.explorerUrl("address", address),
          });
        }
        return;
      }

      if (req.method === "POST" && path === "/solana/airdrop") {
        try {
          const body = JSON.parse(await readBody(req));
          const amount = body.amount || 1;
          const sig = await solana.airdrop(solanaKeypair.publicKey.toBase58(), amount);
          json(res, 200, {
            success: true,
            amount,
            tx_signature: sig,
            explorer_url: solana.explorerUrl("tx", sig),
          });
        } catch (err) {
          json(res, 422, { success: false, error: (err as Error).message });
        }
        return;
      }

      if (req.method === "POST" && path === "/solana/token/create") {
        try {
          const body = JSON.parse(await readBody(req));
          const decimals = body.decimals ?? 9;
          const result = await solana.createToken(solanaKeypair, decimals);

          // Also mint initial supply if specified
          let mintResult = null;
          if (body.initial_supply && body.initial_supply > 0) {
            mintResult = await solana.mintTokens(
              solanaKeypair,
              result.mintAddress,
              body.initial_supply,
              decimals
            );
          }

          // Register in local economic state too
          const tokenId = `sol:${result.mintAddress}`;
          economic.registerExternalToken(
            tokenId,
            body.name || "SPL Token",
            body.symbol || "SPL",
            decimals,
            "solana",
            result.mintAddress
          );
          saveEconomicState(dataDir, economic);

          json(res, 200, {
            success: true,
            token_id: tokenId,
            mint_address: result.mintAddress,
            decimals,
            initial_supply: body.initial_supply || 0,
            mint_tx: mintResult?.txSignature || null,
            explorer_url: result.explorerUrl,
            mint_explorer_url: mintResult?.explorerUrl || null,
          });
        } catch (err) {
          json(res, 422, { success: false, error: (err as Error).message });
        }
        return;
      }

      if (req.method === "POST" && path === "/solana/token/mint") {
        try {
          const body = JSON.parse(await readBody(req));
          const { mint_address, amount, decimals } = body;
          if (!mint_address || !amount) {
            json(res, 400, { error: "mint_address and amount required" });
            return;
          }
          const result = await solana.mintTokens(
            solanaKeypair,
            mint_address,
            amount,
            decimals ?? 9
          );
          json(res, 200, {
            success: true,
            tx_signature: result.txSignature,
            explorer_url: result.explorerUrl,
          });
        } catch (err) {
          json(res, 422, { success: false, error: (err as Error).message });
        }
        return;
      }

      if (req.method === "POST" && path === "/solana/token/transfer") {
        try {
          const body = JSON.parse(await readBody(req));
          const { mint_address, to_address, amount, decimals } = body;
          if (!mint_address || !to_address || !amount) {
            json(res, 400, { error: "mint_address, to_address, and amount required" });
            return;
          }
          const result = await solana.transferTokens(
            solanaKeypair,
            mint_address,
            to_address,
            amount,
            decimals ?? 9
          );

          // Record in local ledger
          const tokenId = `sol:${mint_address}`;
          const privateKey = (await import("../lib/crypto/keys")).fromBase64(agent.getPrivateKey());
          const keyId = (agent as any).state?.keyId || "unknown";
          // Use a dummy transfer in economic manager to record the ledger entry
          const myAgentId = agent.getAgentInfo().agent_id;
          economic.transfer(
            `solana:${to_address}` as any,
            tokenId,
            amount,
            privateKey,
            keyId
          );
          saveEconomicState(dataDir, economic);

          json(res, 200, {
            success: true,
            tx_signature: result.txSignature,
            explorer_url: result.explorerUrl,
          });
        } catch (err) {
          json(res, 422, { success: false, error: (err as Error).message });
        }
        return;
      }

      if (req.method === "GET" && path === "/solana/token/balance") {
        try {
          const mintAddress = url.searchParams.get("mint_address");
          const ownerAddress = url.searchParams.get("owner_address") || solanaKeypair.publicKey.toBase58();
          if (!mintAddress) {
            json(res, 400, { error: "mint_address required" });
            return;
          }
          const balance = await solana.getTokenBalance(ownerAddress, mintAddress);
          json(res, 200, {
            owner: ownerAddress,
            mint_address: mintAddress,
            ...balance,
            explorer_url: solana.explorerUrl("address", ownerAddress),
          });
        } catch (err) {
          json(res, 422, { error: (err as Error).message });
        }
        return;
      }

      if (req.method === "GET" && path === "/solana/token/info") {
        try {
          const mintAddress = url.searchParams.get("mint_address");
          if (!mintAddress) {
            json(res, 400, { error: "mint_address required" });
            return;
          }
          const info = await solana.getTokenInfo(mintAddress);
          json(res, 200, {
            mint_address: mintAddress,
            ...info,
            explorer_url: solana.explorerUrl("address", mintAddress),
          });
        } catch (err) {
          json(res, 422, { error: (err as Error).message });
        }
        return;
      }

      // ============================================================
      // Security Policy routes
      // ============================================================

      if (req.method === "GET" && path === "/policy") {
        json(res, 200, taskPolicy.serialize());
        return;
      }

      if (req.method === "POST" && path === "/policy") {
        const body = JSON.parse(await readBody(req));
        if (body.policy) taskPolicy.updatePolicy(body.policy);
        if (body.peer_override) {
          const { peer_id, ...override } = body.peer_override;
          if (peer_id) taskPolicy.setPeerOverride(peer_id, override);
        }
        json(res, 200, taskPolicy.serialize());
        return;
      }

      if (req.method === "POST" && path === "/policy/check") {
        const body = JSON.parse(await readBody(req));
        if (!body.from || !body.task) {
          json(res, 400, { error: "from (AgentId) and task (TaskRequest) are required" });
          return;
        }
        const result = taskPolicy.checkTask(body.from, body.task);
        json(res, 200, result);
        return;
      }

      // ============================================================
      // Profile & Matching routes
      // ============================================================

      if (req.method === "GET" && path === "/profile") {
        json(res, 200, profileManager.getLocalProfile());
        return;
      }

      if (req.method === "POST" && path === "/profile") {
        const body = JSON.parse(await readBody(req));
        if (body.skills) profileManager.updateSkills(body.skills);
        if (body.availability) profileManager.setAvailability(body.availability);
        if (body.capability_tier) profileManager.setCapabilityTier(body.capability_tier);
        if (body.task_types) profileManager.setTaskTypes(body.task_types);
        json(res, 200, profileManager.getLocalProfile());
        return;
      }

      if (req.method === "POST" && path === "/match") {
        const body = JSON.parse(await readBody(req));
        if (!body.required_skills || !Array.isArray(body.required_skills)) {
          json(res, 400, { error: "required_skills array is required" });
          return;
        }
        const minScore = body.min_score ?? 0;
        const matches = profileManager.findMatchingPeers(body.required_skills, minScore);
        json(res, 200, { matches });
        return;
      }

      if (req.method === "GET" && path === "/peers/profiles") {
        json(res, 200, { profiles: profileManager.getAllPeerProfiles() });
        return;
      }

      // ============================================================
      // Auction routes
      // ============================================================

      if (req.method === "POST" && path === "/auction/create") {
        const body = JSON.parse(await readBody(req));
        const missing: string[] = [];
        for (const field of ["type", "description", "input", "budget", "bid_deadline", "selection"]) {
          if (body[field] === undefined) missing.push(field);
        }
        if (missing.length > 0) {
          json(res, 400, { error: `Missing required fields: ${missing.join(", ")}` });
          return;
        }

        const record = auction.createAuction({
          type: body.type,
          description: body.description,
          input: body.input,
          budget: body.budget,
          bid_deadline: body.bid_deadline,
          selection: body.selection,
          min_reputation: body.min_reputation,
          required_capabilities: body.required_capabilities,
          required_skills: body.required_skills,
          timeout_ms: body.timeout_ms,
          priority: body.priority,
        });
        auctionOrigins.set(record.task_id, agent.getAgentInfo().agent_id);

        // Push notification: if required_skills set, notify matching peers first
        let notifiedPeers = 0;
        if (body.required_skills && body.required_skills.length > 0) {
          const matches = profileManager.findMatchingPeers(body.required_skills, 0.3);
          const swarm = (agent as any).swarm as SwarmTaskApi;
          for (const match of matches) {
            if (swarm.sendTaskMessage(match.agent_id as AgentId, "task_notify", {
              task_id: record.task_id,
              type: body.type,
              description: body.description,
              required_skills: body.required_skills,
              budget: body.budget,
              match_score: match.score,
            })) {
              notifiedPeers++;
            }
          }
          if (notifiedPeers > 0) {
            console.error(`[Match] Notified ${notifiedPeers} matching peers for ${record.task_id}`);
          }
        }

        const broadcastCount = broadcastAuctionTask(agent, record.broadcast);
        json(res, 200, {
          auction: serializeAuction(record, auctionOrigins),
          broadcast_sent: broadcastCount,
        });
        return;
      }

      if (req.method === "GET" && path === "/auction/list") {
        const status = url.searchParams.get("status") as AuctionStatus | null;
        const auctions = auction.listAuctions(status ?? undefined).map((record) => (
          serializeAuction(record, auctionOrigins)
        ));
        json(res, 200, { auctions });
        return;
      }

      if (req.method === "GET" && path.match(/^\/auction\/[^/]+$/)) {
        const taskId = decodeURIComponent(path.split("/")[2]);
        const record = auction.getAuction(taskId);
        json(res, record ? 200 : 404, record ? serializeAuction(record, auctionOrigins) : { error: "Auction not found" });
        return;
      }

      if (req.method === "POST" && path.match(/^\/auction\/[^/]+\/bid$/)) {
        const taskId = decodeURIComponent(path.split("/")[2]);
        const body = JSON.parse(await readBody(req));
        const record = auction.getAuction(taskId);
        if (!record) {
          json(res, 404, { error: "Auction not found" });
          return;
        }

        const bidder = agent.getAgentInfo().agent_id;
        const originAgentId = auctionOrigins.get(taskId) ?? bidder;
        if (originAgentId === bidder) {
          const result = auction.submitBid(taskId, {
            task_id: taskId,
            bidder,
            price: body.price,
            estimated_duration_ms: body.estimated_duration_ms,
            reputation_score: reputation.getScore(bidder),
            message: body.message,
            capabilities: body.capabilities ?? [],
          });
          json(res, result.success ? 200 : 422, result);
          return;
        }

        const swarm = (agent as any).swarm as SwarmTaskApi;
        const sent = swarm.sendTaskMessage(originAgentId, "task_bid", {
          task_id: taskId,
          price: body.price,
          estimated_duration_ms: body.estimated_duration_ms,
          reputation_score: reputation.getScore(bidder),
          message: body.message,
          capabilities: body.capabilities ?? [],
        });

        json(res, sent ? 200 : 422, sent
          ? { success: true, task_id: taskId, bidder, issuer_agent_id: originAgentId }
          : { success: false, error: "Peer not connected", issuer_agent_id: originAgentId });
        return;
      }

      if (req.method === "POST" && path.match(/^\/auction\/[^/]+\/award$/)) {
        const taskId = decodeURIComponent(path.split("/")[2]);
        if ((auctionOrigins.get(taskId) ?? agent.getAgentInfo().agent_id) !== agent.getAgentInfo().agent_id) {
          json(res, 403, { error: "Only the auction issuer can award bids" });
          return;
        }

        const body = JSON.parse(await readBody(req));
        const record = auction.awardTask(taskId, body.bid_id);
        if (!record) {
          json(res, 422, { error: "Unable to award bid" });
          return;
        }

        const award = buildAuctionAward(record);
        let notified = false;
        if (award && award.awarded_to !== agent.getAgentInfo().agent_id) {
          notified = ((agent as any).swarm as SwarmTaskApi).sendTaskMessage(award.awarded_to, "task_award", award);
        }

        json(res, 200, { auction: serializeAuction(record, auctionOrigins), notified });
        return;
      }

      if (req.method === "POST" && path.match(/^\/auction\/[^/]+\/close$/)) {
        const taskId = decodeURIComponent(path.split("/")[2]);
        if ((auctionOrigins.get(taskId) ?? agent.getAgentInfo().agent_id) !== agent.getAgentInfo().agent_id) {
          json(res, 403, { error: "Only the auction issuer can close bidding" });
          return;
        }

        const record = auction.closeBidding(taskId);
        if (!record) {
          json(res, 422, { error: "Unable to close auction" });
          return;
        }

        const award = buildAuctionAward(record);
        let notified = false;
        if (award && award.awarded_to !== agent.getAgentInfo().agent_id) {
          notified = ((agent as any).swarm as SwarmTaskApi).sendTaskMessage(award.awarded_to, "task_award", award);
        }

        json(res, 200, { auction: serializeAuction(record, auctionOrigins), notified });
        return;
      }

      if (req.method === "POST" && path.match(/^\/auction\/[^/]+\/cancel$/)) {
        const taskId = decodeURIComponent(path.split("/")[2]);
        if ((auctionOrigins.get(taskId) ?? agent.getAgentInfo().agent_id) !== agent.getAgentInfo().agent_id) {
          json(res, 403, { error: "Only the auction issuer can cancel the auction" });
          return;
        }

        const record = auction.cancelAuction(taskId);
        json(res, record ? 200 : 422, record ? serializeAuction(record, auctionOrigins) : { error: "Unable to cancel auction" });
        return;
      }

      if (req.method === "POST" && path.match(/^\/auction\/[^/]+\/prepare$/)) {
        const taskId = decodeURIComponent(path.split("/")[2]);
        if ((auctionOrigins.get(taskId) ?? agent.getAgentInfo().agent_id) !== agent.getAgentInfo().agent_id) {
          json(res, 403, { error: "Only the auction issuer can prepare execution" });
          return;
        }

        const { fromBase64 } = await import("../lib/crypto/keys");
        const privateKey = fromBase64(agent.getPrivateKey());
        const keyId = (agent as any).state?.keyId || "unknown";
        const result = auction.prepareExecution(taskId, privateKey, keyId);
        json(res, result.success ? 200 : 422, result);
        return;
      }

      if (req.method === "POST" && path.match(/^\/auction\/[^/]+\/finalize$/)) {
        const taskId = decodeURIComponent(path.split("/")[2]);
        if ((auctionOrigins.get(taskId) ?? agent.getAgentInfo().agent_id) !== agent.getAgentInfo().agent_id) {
          json(res, 403, { error: "Only the auction issuer can finalize execution" });
          return;
        }

        const body = JSON.parse(await readBody(req));
        const { fromBase64 } = await import("../lib/crypto/keys");
        const privateKey = fromBase64(agent.getPrivateKey());
        const workerPublicKey = fromBase64(body.worker_public_key);
        const keyId = (agent as any).state?.keyId || "unknown";
        const result = auction.finalizeExecution(
          taskId,
          body.proof,
          body.expected_input,
          body.received_output,
          workerPublicKey,
          privateKey,
          keyId
        );
        json(res, result.success ? 200 : 422, result);
        return;
      }

      json(res, 404, { error: "Not found" });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.error(`[Daemon] API listening on http://127.0.0.1:${port}`);
  });

  return server;
}

// --- Discovery routes (added to existing server) ---

function addDiscoveryRoutes(
  agent: P2PAgent,
  discovery: DiscoveryClient,
  pendingRequests: ConnectionRequest[],
  inviteManager: InviteManager
) {
  return {
    handleDiscoveryRoute: async (
      req: IncomingMessage,
      res: ServerResponse,
      path: string
    ): Promise<boolean> => {
      if (req.method === "POST" && path === "/discovery/register") {
        const result = await discovery.register();
        json(res, 200, result);
        return true;
      }

      if (req.method === "POST" && path === "/discovery/unregister") {
        discovery.stopPolling();
        const result = await discovery.unregister();
        json(res, 200, result);
        return true;
      }

      if (req.method === "GET" && path === "/discovery/requests") {
        json(res, 200, { requests: pendingRequests });
        return true;
      }

      if (req.method === "POST" && path.startsWith("/discovery/requests/")) {
        const parts = path.split("/");
        const requestId = parts[3];
        const action = parts[4]; // accept or reject
        if (action === "accept" || action === "reject") {
          // Find the request before removing it
          const request = pendingRequests.find(r => r.id === requestId);
          const result = await discovery.ackRequest(requestId, action);
          // Remove from pending
          const idx = pendingRequests.findIndex(r => r.id === requestId);
          if (idx !== -1) pendingRequests.splice(idx, 1);

          // On accept: auto-connect via invite code
          if (action === "accept" && request?.from_agent_id) {
            const inviteCode = (request as any).invite_code;
            if (inviteCode) {
              console.error(`[Discovery] Accepted ${request.from_agent_id} — connecting via invite code ${inviteCode}`);
              // Accept the invite to establish P2P connection
              inviteManager.accept(inviteCode).then((r: any) => {
                  if (r.success) {
                    console.error(`[Discovery] P2P connected to ${r.peerAgentId} via invite`);
                  } else {
                    console.error(`[Discovery] Invite accept failed: ${r.error}`);
                  }
                }).catch((e: Error) => {
                  console.error(`[Discovery] Invite accept error: ${e.message}`);
                });
            } else {
              console.error(`[Discovery] Accepted ${request.from_agent_id} — no invite code, manual connection needed`);
            }
          }

          json(res, 200, result);
          return true;
        }
      }

      if (req.method === "GET" && path === "/discovery/agents") {
        try {
          const data = await discovery.listAgents();
          json(res, 200, data);
        } catch (err) {
          json(res, 502, { error: `Discovery fetch failed: ${(err as Error).message}` });
        }
        return true;
      }

      return false;
    },
  };
}

// --- Main ---

async function main() {
  const config = parseArgs();

  console.error(`[Daemon] Starting agent: ${config.agentId}`);
  console.error(`[Daemon] Data dir: ${config.dataDir}`);
  console.error(`[Daemon] Namespace: ${config.namespace}`);

  const agent = new P2PAgent({
    agentId: config.agentId,
    orgId: config.orgId,
    namespace: config.namespace,
    dataDir: config.dataDir,
  });

  await agent.start();
  const billing = config.enableBilling ? new BillingPlugin(agent) : null;
  billing?.start();
  const inviteManager = new InviteManager(config.agentId);
  const taskManager = new TaskManager(config.agentId, ["generic", "code_review", "run_tests", "transform"], 5);
  const reputation = new ReputationManager();
  const verifier = new ExecutionVerifier();
  const economic = new EconomicManager(config.agentId);
  loadEconomicState(config.dataDir, economic);
  const profileManager = new ProfileManager(config.agentId, reputation);

  // Auto-detect skills from workspace
  const detectedSkills = WorkspaceIntrospector.scanDirectory(process.cwd());
  if (detectedSkills.length > 0) {
    profileManager.updateSkills(detectedSkills);
    console.error(`[Profile] Auto-detected ${detectedSkills.length} skills: ${detectedSkills.map(s => s.skill).join(", ")}`);
  }

  const auction = new AuctionManager({
    agentId: config.agentId,
    reputation,
    economic,
    verifier,
    profileManager,
  });
  const auctionOrigins = new Map<string, AgentId>();
  const taskPolicy = new TaskPolicyManager(config.agentId);

  // --- Solana on-chain setup ---
  const solana = new SolanaClient({
    network: config.solanaNetwork,
    rpcUrl: config.solanaRpcUrl || undefined,
  });
  // Derive Solana keypair from agent's Ed25519 private key (same key type)
  const solanaKeypair = solana.keypairFromPrivateKey(agent.getPrivateKey());
  console.error(`[Solana] Network: ${config.solanaNetwork}`);
  console.error(`[Solana] Wallet: ${solanaKeypair.publicKey.toBase58()}`);
  console.error(`[Solana] Explorer: ${solana.explorerUrl("address", solanaKeypair.publicKey.toBase58())}`);

  // Auto-set default peer config when a peer connects (if not already set via invite)
  (agent as any).swarm.on("peer:identified", (peer: any) => {
    if (peer.agentId && !taskManager.getPeerConfig(peer.agentId)) {
      taskManager.setPeerConfig(peer.agentId, "restricted");
      console.error(`[Daemon] Auto-configured peer ${peer.agentId} as restricted`);
    }
  });

  // Wire up P2P task/heartbeat events to task manager
  (agent as any).swarm.on("task", ({ from, type, payload }: any) => {
    console.error(`[Task] ${type} from ${from}: ${payload.task_id || ""}`);
    if (type === "task_broadcast") {
      const broadcast = payload as TaskBroadcast;
      // Security scan broadcast before registering
      const broadcastScan = taskPolicy.checkTask(from, {
        task_id: broadcast.task_id,
        type: broadcast.type,
        description: broadcast.description,
        input: broadcast.input,
      });
      if (!broadcastScan.allowed) {
        console.error(`[Security] BLOCKED broadcast ${broadcast.task_id} from ${from}: ${broadcastScan.reason}`);
        return;
      }
      auction.registerBroadcast(broadcast);
      auctionOrigins.set(broadcast.task_id, from);
    } else if (type === "task_bid") {
      const bidPayload = payload as {
        task_id: string;
        price: TaskBid["price"];
        estimated_duration_ms: number;
        reputation_score?: number;
        message?: string;
        capabilities?: string[];
      };

      if ((auctionOrigins.get(bidPayload.task_id) ?? config.agentId) !== config.agentId) {
        console.error(`[Auction] Ignored bid for non-local auction ${bidPayload.task_id} from ${from}`);
        return;
      }

      const result = auction.submitBid(bidPayload.task_id, {
        task_id: bidPayload.task_id,
        bidder: from,
        price: bidPayload.price,
        estimated_duration_ms: bidPayload.estimated_duration_ms,
        reputation_score: bidPayload.reputation_score ?? reputation.getScore(from),
        message: bidPayload.message,
        capabilities: bidPayload.capabilities ?? [],
      });

      if (!result.success) {
        console.error(`[Auction] Rejected bid for ${bidPayload.task_id} from ${from}: ${result.error}`);
      }
    } else if (type === "task_award") {
      const award = payload as TaskAward;
      const updated = auction.applyAward(award);
      if (!updated) {
        console.error(`[Auction] Ignored award for unknown task ${award.task_id}`);
      }
    } else if (type === "task_request") {
      const perm = taskManager.checkPermission(from, "task", "send");
      if (!perm.allowed) {
        (agent as any).swarm.sendTaskMessage(from, "task_reject", { task_id: payload.task_id, reason: "Not permitted" });
        return;
      }
      // Security scan before accepting
      const scanResult = taskPolicy.checkTask(from, payload);
      if (!scanResult.allowed) {
        console.error(`[Security] BLOCKED task ${payload.task_id} from ${from}: ${scanResult.reason}`);
        (agent as any).swarm.sendTaskMessage(from, "task_reject", {
          task_id: payload.task_id,
          reason: `Security policy violation: ${scanResult.reason}`,
        });
        return;
      }
      if (scanResult.scan_only && scanResult.threats && scanResult.threats.length > 0) {
        console.error(`[Security] AUDIT task ${payload.task_id} from ${from}: ${scanResult.threats.map((t: any) => t.pattern).join(", ")}`);
      }
      // Store incoming task (preserve original task_id)
      const task = taskManager.storeIncoming(from, payload);
      if (perm.needsApproval) {
        console.error(`[Task] Task ${task.task_id} needs approval`);
        taskManager.emit("task:approval_needed", task);
      } else {
        taskManager.updateTaskStatus(task.task_id, "accepted");
        (agent as any).swarm.sendTaskMessage(from, "task_accept", { task_id: task.task_id });
        taskManager.emit("task:auto_accepted", task);
      }
    } else if (type === "task_accept") {
      taskManager.updateTaskStatus(payload.task_id, "accepted");
    } else if (type === "task_reject") {
      taskManager.updateTaskStatus(payload.task_id, "cancelled");
    } else if (type === "task_result") {
      const task = taskManager.getTask(payload.task_id);
      taskManager.updateTaskStatus(payload.task_id, payload.status === "completed" ? "completed" : "failed", payload);
      // Update reputation based on task outcome
      if (task) {
        const responseMs = task.updated_at - task.created_at;
        const executionMs = payload.duration_ms || 0;
        if (payload.status === "completed") {
          reputation.recordTaskCompleted(from, responseMs, executionMs);
        } else {
          reputation.recordTaskFailed(from);
        }
      }
    } else if (type === "task_error") {
      taskManager.updateTaskStatus(payload.task_id, "failed");
      reputation.recordTaskFailed(from);
    } else if (type === "task_cancel") {
      taskManager.updateTaskStatus(payload.task_id, "cancelled");
      reputation.recordTaskCancelled(from);
    }
  });

  // Handle incoming P2P token transfers
  (agent as any).swarm.on("token_transfer", ({ from, payload }: any) => {
    console.error(`[Economic] Received token transfer from ${from}: ${payload.amount} of ${payload.token_id}`);
    const transfer = payload as {
      from: AgentId;
      to: AgentId;
      token_id: string;
      amount: number;
      ledger_entry: any;
    };
    // Verify the transfer is addressed to us
    if (transfer.to !== config.agentId) {
      console.error(`[Economic] Ignoring transfer not addressed to us (to: ${transfer.to})`);
      return;
    }
    // Credit our wallet with the received tokens
    // First, ensure token is registered locally (as external reference)
    if (!economic.getToken(transfer.token_id)) {
      economic.registerExternalToken(
        transfer.token_id,
        transfer.token_id, // name = id as fallback
        transfer.token_id.split(":").pop()?.split("-")[0] || "???",
        18,
        "custom"
      );
    }
    // Credit via the receive method
    economic.receiveTransfer(transfer.from, transfer.token_id, transfer.amount, transfer.ledger_entry);
    saveEconomicState(config.dataDir, economic);
    console.error(`[Economic] Credited ${transfer.amount} of ${transfer.token_id} from ${from}`);
  });

  (agent as any).swarm.on("heartbeat", ({ from, payload }: any) => {
    taskManager.emit("heartbeat:received", { from, ...payload });
    // Cache peer profile from heartbeat
    if (payload.profile) {
      profileManager.updatePeerProfile(payload.profile);
    }
  });

  // Handle task_poll from workers: dequeue a task and send it
  (agent as any).swarm.on("task_poll", ({ from, capabilities }: any) => {
    const task = taskManager.dequeue(from, capabilities);
    (agent as any).swarm.sendTaskMessage(from, "task_poll_response", task || null);
  });

  // Handle task_poll_response (we're the worker, received a task)
  (agent as any).swarm.on("task_poll_response", ({ from, task }: any) => {
    if (task) {
      taskManager.emit("worker:task_received", { from, task });
    }
  });

  // Auto-adjust peer permissions based on reputation
  reputation.on("reputation:mode_suggestion", ({ agent_id, score, suggested_mode, reason }: any) => {
    const current = taskManager.getPeerConfig(agent_id);
    if (current && current.mode !== suggested_mode) {
      console.error(`[Reputation] ${agent_id} score=${score.toFixed(3)}: ${reason} → adjusting to ${suggested_mode}`);
      taskManager.setPeerConfig(agent_id, suggested_mode);
    }
  });

  // Start heartbeat + task queue poll every 30s (attach profile for skill matching)
  taskManager.startHeartbeat(30_000, (hb: Heartbeat) => {
    hb.profile = profileManager.getLocalProfile();
    (agent as any).swarm.broadcastHeartbeat(hb);
  });

  // Auto-set peer config on invite success — each side sets its own mode
  inviteManager.on("invite:accepted", ({ code, peerAgentId, peerMode, myMode, sharedNamespace }: any) => {
    console.error(`[Invite] Peer ${peerAgentId} connected via ${code} (my mode: ${myMode}, peer mode: ${peerMode})`);
    if (sharedNamespace) {
      agent.joinNamespace(sharedNamespace);
      console.error(`[Invite] Joined shared namespace: ${sharedNamespace.slice(0, 16)}...`);
    }
    // Set what THIS peer is allowed to do on OUR side (their mode toward us)
    taskManager.setPeerConfig(peerAgentId, peerMode || "restricted", sharedNamespace);
  });
  inviteManager.on("invite:connected", ({ code, peerAgentId, peerMode, myMode, sharedNamespace }: any) => {
    console.error(`[Invite] Connected to ${peerAgentId} via ${code} (my mode: ${myMode}, peer mode: ${peerMode})`);
    if (sharedNamespace) {
      agent.joinNamespace(sharedNamespace);
      console.error(`[Invite] Joined shared namespace: ${sharedNamespace.slice(0, 16)}...`);
    }
    // Set what THIS peer is allowed to do on OUR side (their mode toward us)
    taskManager.setPeerConfig(peerAgentId, peerMode || "restricted", sharedNamespace);
  });

  // Load or create API auth token
  const apiToken = loadOrCreateApiToken(config.dataDir);
  console.error(`[Daemon] Auth token file: ${join(config.dataDir, "api-token")}`);

  const planner = new TaskPlanner(taskManager);

  planner.on("step:enqueued", ({ planId, stepId, taskId }: any) => {
    console.error(`[Plan] ${planId} step ${stepId} enqueued as ${taskId}`);
  });
  planner.on("plan:completed", ({ planId, status }: any) => {
    console.error(`[Plan] ${planId} ${status}`);
  });

  const httpServer = createDaemonApi(
    agent,
    config.port,
    inviteManager,
    apiToken,
    taskManager,
    planner,
    reputation,
    verifier,
    economic,
    auction,
    auctionOrigins,
    billing,
    profileManager,
    taskPolicy,
    config.dataDir,
    solana,
    solanaKeypair
  );

  // Discovery site integration
  let discovery: DiscoveryClient | null = null;
  const pendingRequests: ConnectionRequest[] = [];

  if (config.discoveryUrl) {
    const agentInfo = agent.getAgentInfo();
    discovery = new DiscoveryClient({
      discoveryUrl: config.discoveryUrl,
      agentId: config.agentId,
      orgId: config.orgId,
      publicKey: agentInfo.public_key,
      privateKey: agent.getPrivateKey(),
      capabilities: ["data.transfer", "task.execute", "task.bid", "file.send"],
      description: config.description,
    });

    // Register as public
    try {
      await discovery.register();
      console.error(`[Discovery] Registered as public on ${config.discoveryUrl}`);
    } catch (err) {
      console.error(`[Discovery] Registration failed: ${(err as Error).message}`);
    }

    // Poll every 60s for connection requests
    discovery.startPolling(60_000, (req) => {
      pendingRequests.push(req);
      console.error(`[Discovery] New connection request from ${req.from_name || req.from_agent_id || 'anonymous'}: ${req.message || '(no message)'}`);
    });

    // Add discovery routes to the HTTP server
    const { handleDiscoveryRoute } = addDiscoveryRoutes(agent, discovery, pendingRequests, inviteManager);
    const originalListeners = httpServer.listeners('request') as Function[];
    httpServer.removeAllListeners('request');
    httpServer.on('request', async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://localhost:${config.port}`);
      if (url.pathname.startsWith('/discovery/')) {
        const handled = await handleDiscoveryRoute(req, res, url.pathname);
        if (handled) return;
      }
      // Fall through to original handler
      for (const listener of originalListeners) {
        listener(req, res);
      }
    });
  }

  // Fallback: /discovery/agents works even without --discovery-url
  if (!discovery) {
    const originalListeners2 = httpServer.listeners('request') as Function[];
    httpServer.removeAllListeners('request');
    httpServer.on('request', async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://localhost:${config.port}`);
      if (req.method === "GET" && url.pathname === "/discovery/agents") {
        // Check auth
        if (!checkBearerAuth(req, apiToken)) {
          json(res, 401, { error: "Unauthorized" });
          return;
        }
        try {
          const resp = await fetch("https://agent-p2p-discovery.pages.dev/api/agents");
          const data = await resp.json();
          json(res, 200, data);
        } catch (err) {
          json(res, 502, { error: `Discovery fetch failed: ${(err as Error).message}` });
        }
        return;
      }
      for (const listener of originalListeners2) listener(req, res);
    });
  }

  // Log new inbox messages
  agent.on("inbox:new", (msg: any) => {
    console.error(
      `[Daemon] New message: ${msg.envelope.message_type} from ${msg.envelope.from}`
    );
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.error("[Daemon] Shutting down...");
    saveEconomicState(config.dataDir, economic);
    discovery?.stopPolling();
    planner.destroy();
    taskManager.destroy();
    auction.destroy();
    reputation.destroy();
    verifier.destroy();
    economic.destroy();
    billing?.stop();
    await inviteManager.destroy();
    httpServer.close();
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[Daemon] Fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
