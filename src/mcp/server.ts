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
 *   claude mcp add billing -- npx tsx /path/to/agent-p2p/src/mcp/server.ts \
 *     --daemon-url http://127.0.0.1:7700
 *
 *   claude mcp add ap -- npx tsx /path/to/agent-p2p/src/mcp/server.ts \
 *     --daemon-url http://127.0.0.1:7701
 */

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

const DAEMON_URL = getDaemonUrl();

// --- Daemon HTTP client ---

async function daemonGet(path: string): Promise<unknown> {
  const res = await fetch(`${DAEMON_URL}${path}`);
  return res.json();
}

async function daemonPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${DAEMON_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// --- MCP Tool Definitions ---

const TOOLS = [
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
    tools: TOOLS,
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

        case "invoice_issue":
          data = await daemonPost("/invoices/issue", {
            target_agent_id: args?.target_agent_id,
            invoice: args?.invoice,
          });
          break;

        case "invoice_status":
          data = await daemonGet(
            `/invoices?invoice_id=${encodeURIComponent(args?.invoice_id as string)}`
          );
          break;

        case "invoice_list":
          data = await daemonGet("/invoices");
          break;

        case "invoice_accept":
          data = await daemonPost("/invoices/accept", {
            invoice_id: args?.invoice_id,
            scheduled_payment_date: args?.scheduled_payment_date,
          });
          break;

        case "invoice_reject":
          data = await daemonPost("/invoices/reject", {
            invoice_id: args?.invoice_id,
            reason_code: args?.reason_code,
            reason_message: args?.reason_message,
          });
          break;

        case "inbox_list":
          data = await daemonGet("/inbox");
          break;

        case "inbox_process":
          data = await daemonPost("/inbox/process", {});
          break;

        case "audit_log": {
          const qp = args?.invoice_id
            ? `?invoice_id=${encodeURIComponent(args.invoice_id as string)}`
            : "";
          data = await daemonGet(`/audit${qp}`);
          break;
        }

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
    resources: [
      {
        uri: "agent://identity",
        name: "Agent Identity",
        description: "Agent ID, public key, connection info",
        mimeType: "application/json",
      },
      {
        uri: "agent://invoices",
        name: "All Invoices",
        description: "All invoices and their states",
        mimeType: "application/json",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    let data: unknown;

    switch (uri) {
      case "agent://identity":
        data = await daemonGet("/info");
        break;
      case "agent://invoices":
        data = await daemonGet("/invoices");
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
