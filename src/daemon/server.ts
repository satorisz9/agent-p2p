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
import { DiscoveryClient, type ConnectionRequest } from "../lib/discovery/client";
import { InviteManager } from "../lib/invite/manager";
import { TaskManager } from "../lib/task/manager";
import { TaskPlanner, type Plan } from "../lib/task/planner";
import { ReputationManager } from "../lib/reputation/manager";
import { ExecutionVerifier } from "../lib/verification/prover";
import { EconomicManager } from "../lib/economic/wallet";
import type { AgentId, OrgId, ConnectionMode, Heartbeat, InvoiceIssuePayload, ExecutionProof } from "../types/protocol";

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

  return {
    agentId: get("--agent-id") as AgentId,
    orgId: get("--org-id") as OrgId,
    namespace: get("--namespace"),
    dataDir: get("--data-dir"),
    port: parseInt(get("--port", "7700"), 10),
    discoveryUrl: get("--discovery-url", ""),
    description: get("--description", ""),
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

function createDaemonApi(agent: P2PAgent, port: number, inviteManager: InviteManager, apiToken: string, taskManager: TaskManager, planner: TaskPlanner, reputation: ReputationManager, verifier: ExecutionVerifier, economic: EconomicManager) {
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
        json(res, 200, agent.getAgentInfo());
        return;
      }

      if (req.method === "GET" && path === "/peers") {
        json(res, 200, agent.getConnectedPeers());
        return;
      }

      if (req.method === "GET" && path === "/invoices") {
        const invoiceId = url.searchParams.get("invoice_id");
        if (invoiceId) {
          const inv = agent.getInvoice(invoiceId);
          const audit = agent.getAuditLog(invoiceId);
          json(res, inv ? 200 : 404, { invoice: inv, audit });
        } else {
          json(res, 200, agent.listInvoices());
        }
        return;
      }

      if (req.method === "POST" && path === "/invoices/issue") {
        const body = JSON.parse(await readBody(req));
        const result = agent.issueInvoice(
          body.target_agent_id as AgentId,
          body.invoice as InvoiceIssuePayload
        );
        json(res, result.success ? 200 : 422, result);
        return;
      }

      if (req.method === "POST" && path === "/invoices/accept") {
        const body = JSON.parse(await readBody(req));
        const result = agent.acceptInvoice(
          body.invoice_id,
          body.scheduled_payment_date
        );
        json(res, result.success ? 200 : 422, result);
        return;
      }

      if (req.method === "POST" && path === "/invoices/reject") {
        const body = JSON.parse(await readBody(req));
        const result = agent.rejectInvoice(
          body.invoice_id,
          body.reason_code,
          body.reason_message
        );
        json(res, result.success ? 200 : 422, result);
        return;
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

      if (req.method === "GET" && path === "/audit") {
        const invoiceId = url.searchParams.get("invoice_id") ?? undefined;
        json(res, 200, agent.getAuditLog(invoiceId));
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
        json(res, 200, token);
        return;
      }

      if (req.method === "POST" && path === "/token/register") {
        const body = JSON.parse(await readBody(req));
        const token = economic.registerExternalToken(
          body.token_id, body.name, body.symbol,
          body.decimals || 18, body.chain, body.contract_address
        );
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
        json(res, result.success ? 200 : 422, result);
        return;
      }

      if (req.method === "POST" && path === "/token/transfer") {
        const body = JSON.parse(await readBody(req));
        const privateKey = (await import("../lib/crypto/keys")).fromBase64(agent.getPrivateKey());
        const keyId = (agent as any).state?.keyId || "unknown";
        const result = economic.transfer(body.to as AgentId, body.token_id, body.amount, privateKey, keyId);
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
        json(res, result.success ? 200 : 422, result);
        return;
      }

      if (req.method === "POST" && path === "/escrow/refund") {
        const body = JSON.parse(await readBody(req));
        const privateKey = (await import("../lib/crypto/keys")).fromBase64(agent.getPrivateKey());
        const keyId = (agent as any).state?.keyId || "unknown";
        const result = economic.refundEscrow(body.escrow_id, privateKey, keyId);
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
  const inviteManager = new InviteManager(config.agentId);
  const taskManager = new TaskManager(config.agentId, ["generic", "code_review", "run_tests", "transform"], 5);
  const reputation = new ReputationManager();
  const verifier = new ExecutionVerifier();
  const economic = new EconomicManager(config.agentId);

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
    if (type === "task_request") {
      const perm = taskManager.checkPermission(from, "task", "send");
      if (!perm.allowed) {
        (agent as any).swarm.sendTaskMessage(from, "task_reject", { task_id: payload.task_id, reason: "Not permitted" });
        return;
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

  (agent as any).swarm.on("heartbeat", ({ from, payload }: any) => {
    taskManager.emit("heartbeat:received", { from, ...payload });
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

  // Start heartbeat + task queue poll every 30s
  taskManager.startHeartbeat(30_000, (hb: Heartbeat) => {
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

  const httpServer = createDaemonApi(agent, config.port, inviteManager, apiToken, taskManager, planner, reputation, verifier, economic);

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

  // Log new inbox messages
  agent.on("inbox:new", (msg: any) => {
    console.error(
      `[Daemon] New message: ${msg.envelope.message_type} from ${msg.envelope.from}`
    );
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.error("[Daemon] Shutting down...");
    discovery?.stopPolling();
    planner.destroy();
    taskManager.destroy();
    reputation.destroy();
    verifier.destroy();
    economic.destroy();
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
