#!/usr/bin/env node

/**
 * Agent P2P — MCP Server (thin proxy to daemon)
 *
 * This is a lightweight proxy that Claude Code connects to via stdio.
 * All actual logic runs in the daemon process (agent-p2p daemon).
 *
 * This means:
 *   - Claude Code can restart without killing the P2P network
 *   - Multiple Claude Code sessions can share the same daemon
 *   - The daemon handles state, retry, and network independently
 *
 * Usage:
 *   claude mcp add agent-a -- npx tsx /path/to/agent-p2p/src/mcp/server.ts \
 *     --daemon-url http://127.0.0.1:7700
 *
 *   claude mcp add agent-b -- npx tsx /path/to/agent-p2p/src/mcp/server.ts \
 *     --daemon-url http://127.0.0.1:7701
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// --- Parse args ---

function getDaemonUrl(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--daemon-url");
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return process.env.AGENT_DAEMON_URL ?? "http://127.0.0.1:7700";
}

function getDataDir(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--data-dir");
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return process.env.AGENT_DATA_DIR ?? "";
}

function loadApiToken(): string | null {
  // Explicit token via env or CLI
  if (process.env.AGENT_API_TOKEN) return process.env.AGENT_API_TOKEN;
  const args = process.argv.slice(2);
  const idx = args.indexOf("--api-token");
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];

  // Try reading from data dir
  const dataDir = getDataDir();
  if (dataDir) {
    const tokenFile = join(dataDir, "api-token");
    if (existsSync(tokenFile)) {
      return readFileSync(tokenFile, "utf8").trim();
    }
  }

  return null;
}

const DAEMON_URL = getDaemonUrl();
const API_TOKEN = loadApiToken();

// --- Daemon HTTP client ---

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (API_TOKEN) {
    headers["Authorization"] = `Bearer ${API_TOKEN}`;
  }
  return headers;
}

async function daemonGet(path: string): Promise<unknown> {
  const res = await fetch(`${DAEMON_URL}${path}`, {
    headers: authHeaders(),
  });
  return res.json();
}

async function daemonPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${DAEMON_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function isBillingEnabled(): Promise<boolean> {
  try {
    const info = (await daemonGet("/info")) as { billing_enabled?: boolean };
    return info.billing_enabled === true;
  } catch {
    return false;
  }
}

// --- MCP Tool Definitions ---

const BASE_TOOLS = [
  {
    name: "agent_info",
    description:
      "Get this agent's identity, public key, connected peers, and inbox status",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "peer_list",
    description: "List currently connected P2P peers",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "task_request",
    description:
      "Request a task from a target peer in the P2P marketplace.",
    inputSchema: {
      type: "object" as const,
      required: ["target_agent_id", "type", "description", "input"],
      properties: {
        target_agent_id: { type: "string" },
        type: { type: "string", description: "Task type/capability identifier" },
        description: { type: "string", description: "Human-readable task description" },
        input: { type: "object", description: "Structured task input payload" },
      },
    },
  },
  {
    name: "task_list",
    description: "List tracked tasks in the local daemon.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string", description: "Optional task status filter" },
      },
    },
  },
  {
    name: "task_respond",
    description:
      "Respond to a task request with an action such as accept, reject, complete, fail, or cancel.",
    inputSchema: {
      type: "object" as const,
      required: ["task_id", "action"],
      properties: {
        task_id: { type: "string" },
        action: { type: "string", description: "accept | reject | complete | fail | cancel" },
        output: { type: "object", description: "Task output for completion responses" },
        reason: { type: "string", description: "Reason for reject/cancel" },
      },
    },
  },
  {
    name: "file_send",
    description: "Send a local file to a connected peer.",
    inputSchema: {
      type: "object" as const,
      required: ["target_agent_id", "file_path"],
      properties: {
        target_agent_id: { type: "string" },
        file_path: { type: "string" },
      },
    },
  },
  {
    name: "reputation_query",
    description: "Query reputation records for a specific agent or the full registry.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: { type: "string", description: "Optional agent ID to query" },
      },
    },
  },
  {
    name: "wallet_balance",
    description: "Query wallet balance for a token and optional agent.",
    inputSchema: {
      type: "object" as const,
      required: ["token_id"],
      properties: {
        token_id: { type: "string" },
        agent_id: { type: "string", description: "Optional agent ID override" },
      },
    },
  },
  {
    name: "token_issue",
    description: "Issue a new marketplace token to the local agent wallet.",
    inputSchema: {
      type: "object" as const,
      required: ["name", "symbol", "initial_supply"],
      properties: {
        name: { type: "string" },
        symbol: { type: "string" },
        initial_supply: { type: "number" },
      },
    },
  },
  {
    name: "escrow_lock",
    description: "Lock escrow funds for an accepted marketplace offer.",
    inputSchema: {
      type: "object" as const,
      required: ["offer_id"],
      properties: {
        offer_id: { type: "string" },
      },
    },
  },
  {
    name: "escrow_release",
    description: "Release a locked escrow after proof verification.",
    inputSchema: {
      type: "object" as const,
      required: ["escrow_id", "proof_id"],
      properties: {
        escrow_id: { type: "string" },
        proof_id: { type: "string" },
      },
    },
  },
  {
    name: "auction_create",
    description: "Create a marketplace auction and broadcast it to connected peers.",
    inputSchema: {
      type: "object" as const,
      required: ["type", "description", "input", "budget", "bid_deadline", "selection"],
      properties: {
        type: { type: "string" },
        description: { type: "string" },
        input: { type: "object", description: "Structured task input payload" },
        budget: {
          type: "object",
          description: "Budget object with token_id and max_amount",
        },
        bid_deadline: { type: "string", description: "Bid deadline in ISO 8601 format" },
        selection: { type: "string", description: "lowest_price | highest_reputation | best_value | manual" },
        min_reputation: { type: "number" },
        required_capabilities: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
  },
  {
    name: "auction_list",
    description: "List auctions tracked by the local daemon, optionally filtered by status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string", description: "Optional auction status filter" },
      },
    },
  },
  {
    name: "auction_bid",
    description: "Submit a bid for a known auction.",
    inputSchema: {
      type: "object" as const,
      required: ["task_id", "price", "estimated_duration_ms", "capabilities"],
      properties: {
        task_id: { type: "string" },
        price: {
          type: "object",
          description: "Price object with token_id and amount",
        },
        estimated_duration_ms: { type: "number" },
        capabilities: {
          type: "array",
          items: { type: "string" },
        },
        message: { type: "string" },
      },
    },
  },
  {
    name: "auction_finalize",
    description: "Finalize an awarded auction by verifying proof and releasing escrow.",
    inputSchema: {
      type: "object" as const,
      required: ["task_id", "proof", "expected_input", "received_output", "worker_public_key"],
      properties: {
        task_id: { type: "string" },
        proof: { type: "object", description: "Execution proof returned by the worker" },
        expected_input: { type: "object" },
        received_output: { type: "object" },
        worker_public_key: { type: "string", description: "Worker public key in base64" },
      },
    },
  },
  {
    name: "inbox_list",
    description:
      "List unprocessed messages in the inbox (received via P2P but not yet validated/processed)",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "inbox_process",
    description:
      "Process the next unprocessed message from the inbox. Validates signature, schema, and business rules, then applies the state transition.",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

const BILLING_TOOLS = [
  {
    name: "invoice_issue",
    description:
      "Issue a new invoice and send it to a target agent via P2P. The invoice is signed with Ed25519 and sent through Hyperswarm (NAT-traversing P2P).",
    inputSchema: {
      type: "object" as const,
      required: ["target_agent_id", "invoice"],
      properties: {
        target_agent_id: {
          type: "string",
          description:
            "Target agent ID (e.g. agent:vendorx:ap). Must be in the same P2P namespace.",
        },
        invoice: {
          type: "object",
          description:
            "Invoice payload with meta (invoice_id, currency) and data (invoice_number, issue_date, due_date, seller, buyer, line_items, subtotal, tax_total, total, payment_terms).",
        },
      },
    },
  },
  {
    name: "invoice_status",
    description:
      "Get the current state and audit trail of a specific invoice by ID",
    inputSchema: {
      type: "object" as const,
      required: ["invoice_id"],
      properties: {
        invoice_id: { type: "string", description: "Invoice ID" },
      },
    },
  },
  {
    name: "invoice_list",
    description: "List all invoices with their current states",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "invoice_accept",
    description:
      "Accept a validated invoice and optionally schedule a payment date. Sends accept message back to the issuer via P2P.",
    inputSchema: {
      type: "object" as const,
      required: ["invoice_id"],
      properties: {
        invoice_id: { type: "string" },
        scheduled_payment_date: {
          type: "string",
          description: "Payment date (YYYY-MM-DD)",
        },
      },
    },
  },
  {
    name: "invoice_reject",
    description: "Reject an invoice with a reason code and message",
    inputSchema: {
      type: "object" as const,
      required: ["invoice_id", "reason_code", "reason_message"],
      properties: {
        invoice_id: { type: "string" },
        reason_code: { type: "string" },
        reason_message: { type: "string" },
      },
    },
  },
  {
    name: "audit_log",
    description: "View audit trail, optionally filtered by invoice ID",
    inputSchema: {
      type: "object" as const,
      properties: {
        invoice_id: {
          type: "string",
          description: "Optional: filter by invoice ID",
        },
      },
    },
  },
];

async function listTools() {
  return (await isBillingEnabled())
    ? [...BASE_TOOLS, ...BILLING_TOOLS]
    : BASE_TOOLS;
}

async function listResources() {
  const resources = [
    {
      uri: "agent://identity",
      name: "Agent Identity",
      description: "Agent ID, public key, connection info",
      mimeType: "application/json",
    },
    {
      uri: "agent://tasks",
      name: "Tracked Tasks",
      description: "All tracked marketplace tasks and their statuses",
      mimeType: "application/json",
    },
    {
      uri: "agent://reputation",
      name: "Reputation Records",
      description: "Known reputation records for agents in the marketplace",
      mimeType: "application/json",
    },
  ];

  if (await isBillingEnabled()) {
    resources.splice(1, 0, {
      uri: "agent://invoices",
      name: "All Invoices",
      description: "All invoices and their states",
      mimeType: "application/json",
    });
  }

  return resources;
}

// --- Main ---

async function main() {
  // Verify daemon is reachable
  try {
    const health = (await daemonGet("/health")) as any;
    console.error(`[MCP] Connected to daemon: ${health.agent_id}`);
  } catch {
    console.error(
      `[MCP] WARNING: Daemon not reachable at ${DAEMON_URL}. Start it first.`
    );
    console.error(
      `[MCP] Commands will fail until daemon is running.`
    );
  }

  const server = new Server(
    { name: "agent-p2p", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  // --- List Tools ---
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await listTools(),
  }));

  // --- Call Tool ---
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let data: unknown;

      switch (name) {
        case "agent_info":
          data = await daemonGet("/info");
          break;

        case "peer_list":
          data = await daemonGet("/peers");
          break;

        case "task_request":
          data = await daemonPost("/task/request", {
            target_agent_id: args?.target_agent_id,
            type: args?.type,
            description: args?.description,
            input: args?.input,
          });
          break;

        case "task_list": {
          const qp = args?.status
            ? `?status=${encodeURIComponent(args.status as string)}`
            : "";
          data = await daemonGet(`/task/list${qp}`);
          break;
        }

        case "task_respond":
          data = await daemonPost("/task/respond", {
            task_id: args?.task_id,
            action: args?.action,
            output: args?.output,
            reason: args?.reason,
          });
          break;

        case "file_send":
          data = await daemonPost("/file/send", {
            target_agent_id: args?.target_agent_id,
            file_path: args?.file_path,
          });
          break;

        case "reputation_query": {
          const qp = args?.agent_id
            ? `?agent_id=${encodeURIComponent(args.agent_id as string)}`
            : "";
          data = await daemonGet(`/reputation${qp}`);
          break;
        }

        case "token_issue":
          data = await daemonPost("/token/issue", {
            name: args?.name,
            symbol: args?.symbol,
            initial_supply: args?.initial_supply,
          });
          break;

        case "wallet_balance": {
          const params = new URLSearchParams({
            token_id: String(args?.token_id ?? ""),
          });
          if (args?.agent_id) {
            params.set("agent_id", String(args.agent_id));
          }
          data = await daemonGet(`/wallet/balance?${params.toString()}`);
          break;
        }

        case "escrow_lock":
          data = await daemonPost("/escrow/lock", {
            offer_id: args?.offer_id,
          });
          break;

        case "escrow_release":
          data = await daemonPost("/escrow/release", {
            escrow_id: args?.escrow_id,
            proof_id: args?.proof_id,
          });
          break;

        case "auction_create":
          data = await daemonPost("/auction/create", {
            type: args?.type,
            description: args?.description,
            input: args?.input,
            budget: args?.budget,
            bid_deadline: args?.bid_deadline,
            selection: args?.selection,
            min_reputation: args?.min_reputation,
            required_capabilities: args?.required_capabilities,
          });
          break;

        case "auction_list": {
          const qp = args?.status
            ? `?status=${encodeURIComponent(args.status as string)}`
            : "";
          data = await daemonGet(`/auction/list${qp}`);
          break;
        }

        case "auction_bid":
          data = await daemonPost(`/auction/${encodeURIComponent(String(args?.task_id ?? ""))}/bid`, {
            price: args?.price,
            estimated_duration_ms: args?.estimated_duration_ms,
            capabilities: args?.capabilities,
            message: args?.message,
          });
          break;

        case "auction_finalize":
          data = await daemonPost(`/auction/${encodeURIComponent(String(args?.task_id ?? ""))}/finalize`, {
            proof: args?.proof,
            expected_input: args?.expected_input,
            received_output: args?.received_output,
            worker_public_key: args?.worker_public_key,
          });
          break;

        case "inbox_list":
          data = await daemonGet("/inbox");
          break;

        case "inbox_process":
          data = await daemonPost("/inbox/process", {});
          break;

        case "audit_log": {
          if (!(await isBillingEnabled())) {
            throw new Error("Billing plugin is disabled on the daemon");
          }
          const qp = args?.invoice_id
            ? `?invoice_id=${encodeURIComponent(args.invoice_id as string)}`
            : "";
          data = await daemonGet(`/audit${qp}`);
          break;
        }

        case "invoice_issue":
          if (!(await isBillingEnabled())) {
            throw new Error("Billing plugin is disabled on the daemon");
          }
          data = await daemonPost("/invoices/issue", {
            target_agent_id: args?.target_agent_id,
            invoice: args?.invoice,
          });
          break;

        case "invoice_status":
          if (!(await isBillingEnabled())) {
            throw new Error("Billing plugin is disabled on the daemon");
          }
          data = await daemonGet(
            `/invoices?invoice_id=${encodeURIComponent(args?.invoice_id as string)}`
          );
          break;

        case "invoice_list":
          if (!(await isBillingEnabled())) {
            throw new Error("Billing plugin is disabled on the daemon");
          }
          data = await daemonGet("/invoices");
          break;

        case "invoice_accept":
          if (!(await isBillingEnabled())) {
            throw new Error("Billing plugin is disabled on the daemon");
          }
          data = await daemonPost("/invoices/accept", {
            invoice_id: args?.invoice_id,
            scheduled_payment_date: args?.scheduled_payment_date,
          });
          break;

        case "invoice_reject":
          if (!(await isBillingEnabled())) {
            throw new Error("Billing plugin is disabled on the daemon");
          }
          data = await daemonPost("/invoices/reject", {
            invoice_id: args?.invoice_id,
            reason_code: args?.reason_code,
            reason_message: args?.reason_message,
          });
          break;

        default:
          data = { error: `Unknown tool: ${name}` };
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: (err as Error).message,
              hint: `Is the daemon running? Check: curl ${DAEMON_URL}/health`,
            }),
          },
        ],
        isError: true,
      };
    }
  });

  // --- Resources ---
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: await listResources(),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    let data: unknown;

    switch (uri) {
      case "agent://identity":
        data = await daemonGet("/info");
        break;
      case "agent://invoices":
        if (!(await isBillingEnabled())) {
          throw new Error("Billing plugin is disabled on the daemon");
        }
        data = await daemonGet("/invoices");
        break;
      case "agent://tasks":
        data = await daemonGet("/task/list");
        break;
      case "agent://reputation":
        data = await daemonGet("/reputation");
        break;
      default:
        throw new Error(`Unknown resource: ${uri}`);
    }

    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  });

  // --- Connect ---
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[MCP] Proxy server running → ${DAEMON_URL}`);
}

main().catch((err) => {
  console.error(`[MCP] Fatal: ${err.message}`);
  process.exit(1);
});
