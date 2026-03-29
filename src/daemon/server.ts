#!/usr/bin/env node

/**
 * Agent Daemon — long-running process independent of Claude Code sessions.
 *
 * Responsibilities:
 *   - Maintains Hyperswarm P2P connections
 *   - Manages invoice state machine
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
 *     --agent-id agent:mindaxis:billing \
 *     --org-id org:mindaxis \
 *     --namespace invoices-2026 \
 *     --data-dir ~/.agent-p2p/billing \
 *     --port 7700
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { InvoiceAgent } from "../agent/core";
import type { AgentId, OrgId, InvoiceIssuePayload } from "../types/protocol";
import { DiscoveryClient, type ConnectionRequest } from "../lib/discovery/client";
import { InviteManager } from "../lib/invite/manager";

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

function createDaemonApi(agent: InvoiceAgent, port: number, inviteManager: InviteManager, apiToken: string) {
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
        const expiresIn = Math.min(Math.max(parsed.expires_in || 600, 60), 86400); // 1min - 24h
        const invite = await inviteManager.create(expiresIn);
        json(res, 200, invite);
        return;
      }

      if (req.method === "POST" && path === "/invite/accept") {
        const body = JSON.parse(await readBody(req));
        if (!body.code) { json(res, 400, { error: "code required" }); return; }
        const result = await inviteManager.accept(body.code);
        json(res, result.success ? 200 : 400, result);
        return;
      }

      if (req.method === "GET" && path === "/invite/pending") {
        json(res, 200, { invites: inviteManager.listPending() });
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
  agent: InvoiceAgent,
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

  const agent = new InvoiceAgent({
    agentId: config.agentId,
    orgId: config.orgId,
    namespace: config.namespace,
    dataDir: config.dataDir,
  });

  await agent.start();
  const inviteManager = new InviteManager(config.agentId);

  inviteManager.on("invite:accepted", ({ code, peerAgentId }: any) => {
    console.error(`[Invite] Peer connected via invite ${code}: ${peerAgentId}`);
  });
  inviteManager.on("invite:connected", ({ code, peerAgentId }: any) => {
    console.error(`[Invite] Connected to peer via invite ${code}: ${peerAgentId}`);
  });

  // Load or create API auth token
  const apiToken = loadOrCreateApiToken(config.dataDir);
  console.error(`[Daemon] API token: ${apiToken}`);
  console.error(`[Daemon] Token file: ${join(config.dataDir, "api-token")}`);

  const httpServer = createDaemonApi(agent, config.port, inviteManager, apiToken);

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
      capabilities: ['data.transfer', 'invoice.issue', 'invoice.accept'],
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
