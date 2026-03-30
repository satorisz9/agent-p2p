import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentId, ExecutionProof } from "../src/types/protocol";

const REPO_ROOT = "/home/opc/agent-p2p";
const NAMESPACE = "e2e-test-security";
const DATA_DIR_A = "/tmp/agent-p2p-e2e-a";
const DATA_DIR_B = "/tmp/agent-p2p-e2e-b";
const AGENT_A = "agent:e2e:alpha" as AgentId;
const AGENT_B = "agent:e2e:beta" as AgentId;
const ORG_A = "org:e2e-alpha";
const ORG_B = "org:e2e-beta";

type HttpMethod = "GET" | "POST";

interface DaemonHandle {
  name: string;
  agentId: AgentId;
  port: number;
  dataDir: string;
  token: string;
  child: ChildProcessWithoutNullStreams;
  logs: string[];
}

interface ApiRequestOptions {
  method?: HttpMethod;
  body?: unknown;
  auth?: boolean;
}

function makeDaemonLogPrefix(handle: Pick<DaemonHandle, "name">): string {
  return `[${handle.name}]`;
}

function trimLogs(logs: string[]): string[] {
  return logs.slice(-120);
}

function formatLogs(handle: Pick<DaemonHandle, "name" | "logs">): string {
  const joined = trimLogs(handle.logs).join("");
  return `${makeDaemonLogPrefix(handle)}\n${joined}`.trim();
}

async function waitFor<T>(
  label: string,
  check: () => Promise<T | null | undefined>,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result !== null && result !== undefined) {
        return result;
      }
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }

  const detail = lastError instanceof Error ? lastError.message : "condition not met";
  throw new Error(`Timed out waiting for ${label}: ${detail}`);
}

async function startDaemon(spec: {
  name: string;
  agentId: AgentId;
  orgId: string;
  port: number;
  dataDir: string;
}): Promise<DaemonHandle> {
  rmSync(spec.dataDir, { recursive: true, force: true });

  const child = spawn(
    "npx",
    [
      "tsx",
      "src/daemon/server.ts",
      "--agent-id",
      spec.agentId,
      "--org-id",
      spec.orgId,
      "--namespace",
      NAMESPACE,
      "--data-dir",
      spec.dataDir,
      "--port",
      String(spec.port),
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const logs: string[] = [];
  const capture = (chunk: Buffer, stream: "stdout" | "stderr") => {
    const text = chunk.toString("utf8");
    logs.push(`${makeDaemonLogPrefix(spec)} ${stream}: ${text}`);
  };

  child.stdout.on("data", (chunk: Buffer) => capture(chunk, "stdout"));
  child.stderr.on("data", (chunk: Buffer) => capture(chunk, "stderr"));
  child.on("exit", (code, signal) => {
    logs.push(`${makeDaemonLogPrefix(spec)} exit: code=${code} signal=${signal}\n`);
  });

  const tokenFile = join(spec.dataDir, "api-token");
  const token = await waitFor(
    `${spec.name} api token`,
    async () => {
      if (!existsSync(tokenFile)) return null;
      const value = readFileSync(tokenFile, "utf8").trim();
      return value.length > 0 ? value : null;
    },
    20_000,
    100,
  );

  const handle: DaemonHandle = {
    name: spec.name,
    agentId: spec.agentId,
    port: spec.port,
    dataDir: spec.dataDir,
    token,
    child,
    logs,
  };

  try {
    await waitFor(
      `${spec.name} health`,
      async () => {
        const response = await fetch(`http://127.0.0.1:${spec.port}/health`);
        if (!response.ok) return null;
        return response.json();
      },
      30_000,
      200,
    );
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${formatLogs(handle)}`);
  }

  return handle;
}

async function stopDaemon(handle: DaemonHandle): Promise<void> {
  if (handle.child.exitCode !== null || handle.child.killed) {
    return;
  }

  handle.child.kill("SIGTERM");

  const exited = await Promise.race([
    new Promise<boolean>((resolve) => {
      handle.child.once("exit", () => resolve(true));
    }),
    delay(10_000).then(() => false),
  ]);

  if (!exited && handle.child.exitCode === null) {
    handle.child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      handle.child.once("exit", () => resolve());
    });
  }
}

async function api<T>(
  handle: DaemonHandle,
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers();

  if (options.auth !== false) {
    headers.set("Authorization", `Bearer ${handle.token}`);
  }

  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method,
    headers,
    body,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${method} ${path}: ${JSON.stringify(data)}\n${formatLogs(handle)}`,
    );
  }

  return data as T;
}

async function waitForPeer(handle: DaemonHandle, peerAgentId: AgentId) {
  return waitFor(
    `${handle.name} peer ${peerAgentId}`,
    async () => {
      const peers = await api<Array<{ agent_id: AgentId; connected: boolean }>>(handle, "/peers");
      return peers.find((peer) => peer.agent_id === peerAgentId && peer.connected) ?? null;
    },
    45_000,
    500,
  );
}

async function getTask(handle: DaemonHandle, taskId: string) {
  return api<{
    task_id: string;
    status: string;
    request: { input: Record<string, unknown> };
    result?: { output?: Record<string, unknown> };
  }>(handle, `/task/${taskId}`);
}

async function waitForTaskStatus(
  handle: DaemonHandle,
  taskId: string,
  statuses: string[],
) {
  return waitFor(
    `${handle.name} task ${taskId} in [${statuses.join(", ")}]`,
    async () => {
      const task = await getTask(handle, taskId);
      return statuses.includes(task.status) ? task : null;
    },
    45_000,
    250,
  );
}

async function waitForEscrowStatus(
  handle: DaemonHandle,
  escrowId: string,
  status: string,
) {
  return waitFor(
    `${handle.name} escrow ${escrowId}=${status}`,
    async () => {
      const payload = await api<{ escrows: Array<{ escrow_id: string; status: string }> }>(
        handle,
        "/escrow/list",
      );
      return payload.escrows.find((escrow) => escrow.escrow_id === escrowId && escrow.status === status) ?? null;
    },
    30_000,
    250,
  );
}

async function getBalance(handle: DaemonHandle, tokenId: string, agentId: AgentId) {
  const params = new URLSearchParams({
    token_id: tokenId,
    agent_id: agentId,
  });
  const payload = await api<{ balance: number }>(handle, `/wallet/balance?${params.toString()}`);
  return payload.balance;
}

async function getReputation(handle: DaemonHandle, agentId: AgentId) {
  return api<{
    agent_id: AgentId;
    score: number;
    tasks_completed: number;
    tasks_failed: number;
    disputes: number;
    verified_proofs: number;
  }>(handle, `/reputation?agent_id=${encodeURIComponent(agentId)}`);
}

function tamperBase64(value: string): string {
  const prefix = value[0] === "A" ? "B" : "A";
  return `${prefix}${value.slice(1)}`;
}

test("security layers e2e via two live daemons", { timeout: 240_000 }, async () => {
  const handles: DaemonHandle[] = [];

  try {
    const daemonA = await startDaemon({
      name: "agent-a",
      agentId: AGENT_A,
      orgId: ORG_A,
      port: 7710,
      dataDir: DATA_DIR_A,
    });
    handles.push(daemonA);

    const daemonB = await startDaemon({
      name: "agent-b",
      agentId: AGENT_B,
      orgId: ORG_B,
      port: 7711,
      dataDir: DATA_DIR_B,
    });
    handles.push(daemonB);

    const infoA = await api<{ agent_id: AgentId; public_key: string }>(daemonA, "/info");
    const infoB = await api<{ agent_id: AgentId; public_key: string }>(daemonB, "/info");
    assert.equal(infoA.agent_id, AGENT_A);
    assert.equal(infoB.agent_id, AGENT_B);

    const invite = await api<{ code: string; mode: string }>(daemonA, "/invite/create", {
      method: "POST",
      body: { expires_in: 600, mode: "restricted" },
    });
    assert.match(invite.code, /^ap2p-/);
    assert.equal(invite.mode, "restricted");

    const accept = await api<{
      success: boolean;
      peerAgentId: AgentId;
      peerMode: string;
      sharedNamespace: string;
    }>(daemonB, "/invite/accept", {
      method: "POST",
      body: { code: invite.code, mode: "restricted" },
    });
    assert.equal(accept.success, true);
    assert.equal(accept.peerAgentId, AGENT_A);
    assert.equal(accept.peerMode, "restricted");
    assert.equal(accept.sharedNamespace.length, 32);

    await Promise.all([
      waitForPeer(daemonA, AGENT_B),
      waitForPeer(daemonB, AGENT_A),
    ]);

    const token = await api<{ token_id: string; symbol: string; total_supply: number }>(
      daemonA,
      "/token/issue",
      {
        method: "POST",
        body: {
          name: "SecurityCoin",
          symbol: "SECU",
          decimals: 18,
          initial_supply: 1000,
        },
      },
    );
    assert.match(token.token_id, /^local:SECU-/);
    assert.equal(token.symbol, "SECU");
    assert.equal(token.total_supply, 1000);
    assert.equal(await getBalance(daemonA, token.token_id, AGENT_A), 1000);
    assert.equal(await getBalance(daemonA, token.token_id, AGENT_B), 0);

    const transferAmount = 120;
    const transfer = await api<{ success: boolean }>(daemonA, "/token/transfer", {
      method: "POST",
      body: {
        to: AGENT_B,
        token_id: token.token_id,
        amount: transferAmount,
      },
    });
    assert.equal(transfer.success, true);
    assert.equal(await getBalance(daemonA, token.token_id, AGENT_A), 880);
    assert.equal(await getBalance(daemonA, token.token_id, AGENT_B), 120);

    const successInput = {
      task: "successful-security-flow",
      payload: "alpha",
    };
    const successRequest = await api<{
      task: {
        task_id: string;
        request: { input: Record<string, unknown> };
      };
      needs_approval: boolean;
    }>(daemonA, "/task/request", {
      method: "POST",
      body: {
        target_agent_id: AGENT_B,
        type: "generic",
        description: "Successful security flow",
        input: successInput,
      },
    });
    assert.equal(successRequest.needs_approval, true);

    const successTaskId = successRequest.task.task_id;
    await waitForTaskStatus(daemonB, successTaskId, ["pending"]);

    const successOffer = await api<{
      offer_id: string;
      task_id: string;
      amount: number;
      status: string;
    }>(daemonA, "/offer/create", {
      method: "POST",
      body: {
        task_id: successTaskId,
        to: AGENT_B,
        token_id: token.token_id,
        amount: 50,
      },
    });
    assert.equal(successOffer.task_id, successTaskId);
    assert.equal(successOffer.status, "offered");

    await api(daemonB, "/task/respond", {
      method: "POST",
      body: { task_id: successTaskId, action: "accept" },
    });
    await Promise.all([
      waitForTaskStatus(daemonA, successTaskId, ["accepted"]),
      waitForTaskStatus(daemonB, successTaskId, ["accepted"]),
    ]);

    const lockedSuccess = await api<{
      success: boolean;
      escrow: { escrow_id: string; status: string; amount: number };
    }>(daemonA, "/escrow/lock", {
      method: "POST",
      body: { offer_id: successOffer.offer_id },
    });
    assert.equal(lockedSuccess.success, true);
    assert.equal(lockedSuccess.escrow.status, "locked");
    assert.equal(lockedSuccess.escrow.amount, 50);
    assert.equal(await getBalance(daemonA, token.token_id, AGENT_A), 830);

    const successChallenge = await api<{ nonce: string; task_id: string }>(
      daemonA,
      "/verification/challenge",
      {
        method: "POST",
        body: { task_id: successTaskId, ttl_ms: 60_000 },
      },
    );
    assert.equal(successChallenge.task_id, successTaskId);

    const successOutput = {
      result: "verified execution",
      artifact: "ok",
      score: 1,
    };
    await api(daemonB, "/task/respond", {
      method: "POST",
      body: {
        task_id: successTaskId,
        action: "complete",
        output: successOutput,
      },
    });

    const completedSuccessTask = await waitForTaskStatus(daemonA, successTaskId, ["completed"]);
    assert.deepEqual(completedSuccessTask.result?.output, successOutput);

    const successProof = await api<ExecutionProof>(daemonB, "/verification/prove", {
      method: "POST",
      body: {
        task_id: successTaskId,
        input: successInput,
        output: successOutput,
        challenge: successChallenge,
      },
    });
    assert.equal(successProof.task_id, successTaskId);

    const verifySuccess = await api<{
      valid: boolean;
      error?: string;
      checks: Record<string, boolean>;
    }>(daemonA, "/verification/verify", {
      method: "POST",
      body: {
        proof: successProof,
        expected_input: successInput,
        received_output: successOutput,
        worker_public_key: infoB.public_key,
        worker_agent_id: AGENT_B,
      },
    });
    assert.equal(verifySuccess.valid, true, verifySuccess.error);
    assert.equal(verifySuccess.checks.signature_valid, true);
    assert.equal(verifySuccess.checks.challenge_valid, true);

    const releaseSuccess = await api<{ success: boolean }>(daemonA, "/escrow/release", {
      method: "POST",
      body: {
        escrow_id: lockedSuccess.escrow.escrow_id,
        proof_id: successProof.proof_id,
      },
    });
    assert.equal(releaseSuccess.success, true);
    await waitForEscrowStatus(daemonA, lockedSuccess.escrow.escrow_id, "released");

    // Economic and reputation state live on the requester's daemon in the current implementation.
    assert.equal(await getBalance(daemonA, token.token_id, AGENT_B), 170);
    const reputationAfterSuccess = await getReputation(daemonA, AGENT_B);
    assert.ok(reputationAfterSuccess.score > 0.5);
    assert.ok(reputationAfterSuccess.tasks_completed >= 2);
    assert.ok(reputationAfterSuccess.verified_proofs >= 1);

    const requesterBalanceBeforeFailure = await getBalance(daemonA, token.token_id, AGENT_A);
    const failureInput = {
      task: "failing-security-flow",
      payload: "beta",
    };
    const failureRequest = await api<{
      task: {
        task_id: string;
      };
    }>(daemonA, "/task/request", {
      method: "POST",
      body: {
        target_agent_id: AGENT_B,
        type: "generic",
        description: "Failure security flow",
        input: failureInput,
      },
    });

    const failureTaskId = failureRequest.task.task_id;
    await waitForTaskStatus(daemonB, failureTaskId, ["pending"]);

    const failureOffer = await api<{
      offer_id: string;
      amount: number;
      status: string;
    }>(daemonA, "/offer/create", {
      method: "POST",
      body: {
        task_id: failureTaskId,
        to: AGENT_B,
        token_id: token.token_id,
        amount: 30,
      },
    });
    assert.equal(failureOffer.status, "offered");

    await api(daemonB, "/task/respond", {
      method: "POST",
      body: { task_id: failureTaskId, action: "accept" },
    });
    await Promise.all([
      waitForTaskStatus(daemonA, failureTaskId, ["accepted"]),
      waitForTaskStatus(daemonB, failureTaskId, ["accepted"]),
    ]);

    const lockedFailure = await api<{
      success: boolean;
      escrow: { escrow_id: string; status: string };
    }>(daemonA, "/escrow/lock", {
      method: "POST",
      body: { offer_id: failureOffer.offer_id },
    });
    assert.equal(lockedFailure.success, true);
    assert.equal(lockedFailure.escrow.status, "locked");
    assert.equal(
      await getBalance(daemonA, token.token_id, AGENT_A),
      requesterBalanceBeforeFailure - 30,
    );

    const failureChallenge = await api<{ nonce: string; task_id: string }>(
      daemonA,
      "/verification/challenge",
      {
        method: "POST",
        body: { task_id: failureTaskId, ttl_ms: 60_000 },
      },
    );
    const claimedFailureOutput = {
      result: "forged execution",
      artifact: "bad",
      score: 0,
    };
    const realFailureProof = await api<ExecutionProof>(daemonB, "/verification/prove", {
      method: "POST",
      body: {
        task_id: failureTaskId,
        input: failureInput,
        output: claimedFailureOutput,
        challenge: failureChallenge,
      },
    });

    const fakeFailureProof: ExecutionProof = {
      ...realFailureProof,
      signature: {
        ...realFailureProof.signature,
        value: tamperBase64(realFailureProof.signature.value),
      },
    };

    const verifyFailure = await api<{
      valid: boolean;
      error?: string;
      checks: Record<string, boolean>;
    }>(daemonA, "/verification/verify", {
      method: "POST",
      body: {
        proof: fakeFailureProof,
        expected_input: failureInput,
        received_output: claimedFailureOutput,
        worker_public_key: infoB.public_key,
        worker_agent_id: AGENT_B,
      },
    });
    assert.equal(verifyFailure.valid, false);
    assert.equal(verifyFailure.checks.signature_valid, false);

    await api(daemonB, "/task/respond", {
      method: "POST",
      body: {
        task_id: failureTaskId,
        action: "fail",
        error: "proof verification failed",
        retryable: false,
      },
    });
    await waitForTaskStatus(daemonA, failureTaskId, ["failed"]);

    const reputationBeforeDispute = await getReputation(daemonA, AGENT_B);
    assert.ok(reputationBeforeDispute.tasks_failed >= 1);

    const disputeFailure = await api<{ success: boolean }>(daemonA, "/escrow/dispute", {
      method: "POST",
      body: { escrow_id: lockedFailure.escrow.escrow_id },
    });
    assert.equal(disputeFailure.success, true);

    const reputationAfterDispute = await getReputation(daemonA, AGENT_B);
    assert.ok(reputationAfterDispute.disputes >= reputationBeforeDispute.disputes + 1);
    assert.ok(reputationAfterDispute.score < reputationBeforeDispute.score);

    const refundFailure = await api<{ success: boolean }>(daemonA, "/escrow/refund", {
      method: "POST",
      body: { escrow_id: lockedFailure.escrow.escrow_id },
    });
    assert.equal(refundFailure.success, true);
    await waitForEscrowStatus(daemonA, lockedFailure.escrow.escrow_id, "refunded");

    assert.equal(await getBalance(daemonA, token.token_id, AGENT_A), requesterBalanceBeforeFailure);
    assert.equal(await getBalance(daemonA, token.token_id, AGENT_B), 170);

    const ledgerIntegrity = await api<{ valid: boolean; broken_at?: number }>(
      daemonA,
      "/ledger/verify",
    );
    assert.equal(ledgerIntegrity.valid, true);
  } finally {
    await Promise.all(handles.map((handle) => stopDaemon(handle)));
  }
});
