/**
 * E2E Project (Virtual Company) & Webhook Tests
 *
 * Tests:
 *   1. Create project with local token
 *   2. Fund project
 *   3. Assign and complete tasks
 *   4. Calculate reward distribution
 *   5. Broadcast project to P2P peer
 *   6. Webhook receives notifications
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "child_process";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";

const PORT_A = 7740;
const PORT_B = 7741;
const WEBHOOK_PORT = 7742;
const DATA_A = "/tmp/agent-p2p-e2e-proj-a";
const DATA_B = "/tmp/agent-p2p-e2e-proj-b";
const AGENT_A = "agent:proj:alice";
const AGENT_B = "agent:proj:bob";
const NAMESPACE = "e2e-test-project";

let procA: ChildProcess;
let procB: ChildProcess;
let tokenA: string;
let tokenB: string;
let webhookServer: ReturnType<typeof createServer>;
const webhookEvents: Array<{ event: string; data: any }> = [];

async function api(port: number, token: string, method: string, path: string, body?: any): Promise<any> {
  const url = `http://127.0.0.1:${port}${path}`;
  const opts: RequestInit = {
    method,
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _raw: text, _status: res.status }; }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function waitForDaemon(port: number, maxMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try { const res = await fetch(`http://127.0.0.1:${port}/health`); if (res.ok) return; } catch {}
    await sleep(500);
  }
  throw new Error(`Daemon on port ${port} did not start`);
}

function startDaemon(agentId: string, port: number, dataDir: string): ChildProcess {
  const proc = spawn("npx", [
    "tsx", "src/daemon/server.ts",
    "--agent-id", agentId, "--org-id", "org:proj",
    "--namespace", NAMESPACE, "--data-dir", dataDir,
    "--port", String(port), "--solana-network", "devnet",
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENT_P2P_PASSPHRASE: "e2e-project-test" },
  });
  proc.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) process.stderr.write(`[${agentId}] ${line}\n`);
  });
  return proc;
}

describe("Project & Webhook E2E", () => {
  let projectId: string;
  let tokenId: string;

  before(async () => {
    if (existsSync(DATA_A)) rmSync(DATA_A, { recursive: true });
    if (existsSync(DATA_B)) rmSync(DATA_B, { recursive: true });

    // Start webhook receiver
    webhookServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          webhookEvents.push(body);
        } catch {}
        res.writeHead(200);
        res.end("ok");
      });
    });
    await new Promise<void>(r => webhookServer.listen(WEBHOOK_PORT, r));

    procA = startDaemon(AGENT_A, PORT_A, DATA_A);
    procB = startDaemon(AGENT_B, PORT_B, DATA_B);
    await Promise.all([waitForDaemon(PORT_A), waitForDaemon(PORT_B)]);
    tokenA = readFileSync(join(DATA_A, "api-token"), "utf8").trim();
    tokenB = readFileSync(join(DATA_B, "api-token"), "utf8").trim();

    // Connect via invite
    const invite = await api(PORT_A, tokenA, "POST", "/invite/create", {});
    await api(PORT_B, tokenB, "POST", "/invite/accept", { code: invite.code });
    await sleep(3000);

    // Register webhook on Agent A
    await api(PORT_A, tokenA, "POST", "/webhooks", {
      url: `http://127.0.0.1:${WEBHOOK_PORT}/hook`,
      events: ["*"],
    });
  });

  after(() => {
    procA?.kill("SIGTERM");
    procB?.kill("SIGTERM");
    webhookServer?.close();
    if (existsSync(DATA_A)) rmSync(DATA_A, { recursive: true });
    if (existsSync(DATA_B)) rmSync(DATA_B, { recursive: true });
  });

  it("creates a project with local token", async () => {
    const result = await api(PORT_A, tokenA, "POST", "/project/create", {
      name: "Test Project",
      description: "E2E test virtual company",
      symbol: "TPRJ",
      funding_goal: 10000,
      tasks: [
        { type: "code_review", description: "Review module A", budget: 3000 },
        { type: "run_tests", description: "Run test suite", budget: 2000 },
        { type: "transform", description: "Data pipeline", budget: 5000 },
      ],
    });
    assert.ok(result.project_id, `Should create project: ${JSON.stringify(result)}`);
    assert.equal(result.status, "funding");
    assert.equal(result.tasks.length, 3);
    assert.ok(result.token_id);
    projectId = result.project_id;
    tokenId = result.token_id;
    console.log(`  Project: ${projectId}`);
    console.log(`  Token: ${tokenId}`);
  });

  it("funds project to reach goal", async () => {
    // Fund partially
    const r1 = await api(PORT_A, tokenA, "POST", "/project/fund", {
      project_id: projectId, investor: AGENT_A, amount: 6000,
    });
    assert.ok(r1.success);
    assert.equal(r1.project?.status, "funding");

    // Fund to reach goal
    const r2 = await api(PORT_A, tokenA, "POST", "/project/fund", {
      project_id: projectId, investor: AGENT_B, amount: 4000,
    });
    assert.ok(r2.success);
    assert.equal(r2.project?.status, "active");
    console.log(`  Status: active (funded)`);
  });

  it("assigns tasks to agents", async () => {
    const project = await api(PORT_A, tokenA, "GET", `/project/${projectId}`);
    for (const task of project.tasks) {
      const agent = task.type === "code_review" ? AGENT_B : AGENT_A;
      const r = await api(PORT_A, tokenA, "POST", "/project/task/assign", {
        project_id: projectId, task_id: task.task_id, agent_id: agent,
      });
      assert.ok(r.success, `Assign ${task.task_id} failed`);
    }
    const updated = await api(PORT_A, tokenA, "GET", `/project/${projectId}`);
    assert.ok(updated.tasks.every((t: any) => t.status === "active"));
    console.log(`  All 3 tasks assigned`);
  });

  it("completes tasks with proofs", async () => {
    const project = await api(PORT_A, tokenA, "GET", `/project/${projectId}`);
    for (const task of project.tasks) {
      const r = await api(PORT_A, tokenA, "POST", "/project/task/complete", {
        project_id: projectId, task_id: task.task_id, proof_id: `proof_${task.task_id}`,
      });
      assert.ok(r.success);
    }
    const updated = await api(PORT_A, tokenA, "GET", `/project/${projectId}`);
    assert.equal(updated.status, "completed");
    console.log(`  Project completed`);
  });

  it("calculates reward distribution", async () => {
    const dist = await api(PORT_A, tokenA, "GET", `/project/distribute?project_id=${projectId}`);
    assert.ok(dist.success);
    // Alice invested 6000/10000 = 60%, Bob 4000/10000 = 40%
    // But all budget was spent on tasks (3000+2000+5000=10000), so remaining = 0
    assert.equal(dist.total_rewards, 0);
    console.log(`  Distribution: ${JSON.stringify(dist.distribution)}`);
  });

  it("broadcasts project to P2P network", async () => {
    // Create another project to broadcast
    const proj2 = await api(PORT_A, tokenA, "POST", "/project/create", {
      name: "Broadcast Test",
      description: "Testing P2P broadcast",
      symbol: "BCST",
      funding_goal: 5000,
      tasks: [{ type: "review", description: "Review", budget: 5000 }],
    });

    const result = await api(PORT_A, tokenA, "POST", "/project/broadcast", {
      project_id: proj2.project_id,
    });
    assert.ok(result.broadcast);
    assert.equal(result.broadcast.name, "Broadcast Test");
    assert.ok(result.peers_notified >= 0);
    console.log(`  Broadcast sent to ${result.peers_notified} peers`);
  });

  it("webhook received events", async () => {
    await sleep(1000);
    // Check that webhook received project:created events
    const createEvents = webhookEvents.filter(e => e.event === "project:created");
    assert.ok(createEvents.length >= 1, `Should have project:created events, got ${webhookEvents.length} total`);
    console.log(`  Webhook received ${webhookEvents.length} events total`);
    const eventTypes = [...new Set(webhookEvents.map(e => e.event))];
    console.log(`  Event types: ${eventTypes.join(", ")}`);
  });

  it("lists projects", async () => {
    const all = await api(PORT_A, tokenA, "GET", "/project/list");
    assert.ok(all.projects.length >= 2);

    const completed = await api(PORT_A, tokenA, "GET", "/project/list?status=completed");
    assert.ok(completed.projects.length >= 1);
    assert.ok(completed.projects.every((p: any) => p.status === "completed"));

    const funding = await api(PORT_A, tokenA, "GET", "/project/list?status=funding");
    assert.ok(funding.projects.length >= 1);
    console.log(`  Total: ${all.projects.length}, Completed: ${completed.projects.length}, Funding: ${funding.projects.length}`);
  });

  it("webhook registration and listing", async () => {
    const hooks = await api(PORT_A, tokenA, "GET", "/webhooks");
    assert.ok(hooks.webhooks.length >= 1);
    assert.ok(hooks.webhooks[0].events.includes("*"));
    console.log(`  Registered webhooks: ${hooks.webhooks.length}`);
  });
});
