/**
 * Task Manager — handles task lifecycle and peer permissions.
 */

import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import type {
  AgentId,
  PeerConfig,
  PeerPermissions,
  PeerCapability,
  ConnectionMode,
  TaskRequest,
  TaskResult,
  TaskStatus,
  Heartbeat,
  PERMISSION_PRESETS,
} from "../../types/protocol";

export interface TrackedTask {
  task_id: string;
  from: AgentId;
  to: AgentId;
  request: TaskRequest;
  status: TaskStatus;
  result?: TaskResult;
  created_at: number;
  updated_at: number;
}

export class TaskManager extends EventEmitter {
  private agentId: AgentId;
  private tasks = new Map<string, TrackedTask>();
  private peerConfigs = new Map<string, PeerConfig>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private capabilities: string[];
  private maxTasks: number;
  private startTime = Date.now();

  constructor(agentId: AgentId, capabilities: string[] = [], maxTasks = 5) {
    super();
    this.agentId = agentId;
    this.capabilities = capabilities;
    this.maxTasks = maxTasks;
  }

  // --- Peer permissions ---

  setPeerConfig(agentId: AgentId, mode: ConnectionMode, namespace?: string): PeerConfig {
    const { PERMISSION_PRESETS: presets } = require("../../types/protocol");
    const config: PeerConfig = {
      agent_id: agentId,
      mode,
      permissions: { ...presets[mode] },
      connected_at: new Date().toISOString(),
      shared_namespace: namespace,
    };
    this.peerConfigs.set(agentId, config);
    console.error(`[TaskMgr] Peer ${agentId} set to mode: ${mode}`);
    return config;
  }

  getPeerConfig(agentId: AgentId): PeerConfig | undefined {
    return this.peerConfigs.get(agentId);
  }

  listPeers(): PeerConfig[] {
    return Array.from(this.peerConfigs.values());
  }

  checkPermission(agentId: AgentId, capability: PeerCapability, direction: "request" | "send"): { allowed: boolean; needsApproval: boolean } {
    const config = this.peerConfigs.get(agentId);
    if (!config) return { allowed: false, needsApproval: false };

    const perms = config.permissions;
    const list = direction === "request" ? perms.can_request : perms.can_send;
    const allowed = list.includes(capability);
    const needsApproval = perms.requires_approval.includes(capability);

    return { allowed, needsApproval };
  }

  // --- Task lifecycle ---

  createTask(to: AgentId, request: Omit<TaskRequest, "task_id">): TrackedTask {
    const task: TrackedTask = {
      task_id: `task_${randomUUID()}`,
      from: this.agentId,
      to,
      request: { ...request, task_id: `task_${randomUUID()}` },
      status: "pending",
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    task.request.task_id = task.task_id;
    this.tasks.set(task.task_id, task);
    return task;
  }

  updateTaskStatus(taskId: string, status: TaskStatus, result?: TaskResult): TrackedTask | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.status = status;
    task.updated_at = Date.now();
    if (result) task.result = result;
    return task;
  }

  getTask(taskId: string): TrackedTask | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(status?: TaskStatus): TrackedTask[] {
    const all = Array.from(this.tasks.values());
    return status ? all.filter(t => t.status === status) : all;
  }

  getActiveTasks(): number {
    return Array.from(this.tasks.values()).filter(
      t => t.status === "accepted" || t.status === "running"
    ).length;
  }

  // --- Task Queue (for workers to pull from) ---

  private taskQueue: TrackedTask[] = [];
  private workerTimer: ReturnType<typeof setInterval> | null = null;
  private taskHandler: ((task: TrackedTask) => Promise<Record<string, unknown>>) | null = null;

  /** Enqueue a task for any available worker to pick up */
  enqueue(request: Omit<TaskRequest, "task_id">, assignTo?: AgentId): TrackedTask {
    const task: TrackedTask = {
      task_id: `task_${randomUUID()}`,
      from: this.agentId,
      to: (assignTo || this.agentId) as AgentId,
      request: { ...request, task_id: "" },
      status: "pending",
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    task.request.task_id = task.task_id;
    this.tasks.set(task.task_id, task);
    this.taskQueue.push(task);
    console.error(`[TaskQ] Enqueued: ${task.task_id} type=${request.type}`);
    return task;
  }

  /** Dequeue the next pending task (worker pulls) */
  dequeue(workerAgentId: AgentId, capabilities?: string[]): TrackedTask | null {
    const idx = this.taskQueue.findIndex(t => {
      if (t.status !== "pending") return false;
      if (capabilities && !capabilities.includes(t.request.type)) return false;
      return true;
    });
    if (idx === -1) return null;
    const task = this.taskQueue.splice(idx, 1)[0];
    task.to = workerAgentId;
    task.status = "accepted";
    task.updated_at = Date.now();
    console.error(`[TaskQ] Dequeued: ${task.task_id} → ${workerAgentId}`);
    return task;
  }

  /** Get queue length */
  queueLength(): number {
    return this.taskQueue.filter(t => t.status === "pending").length;
  }

  /** Register a handler for executing tasks pulled from peers */
  setTaskHandler(handler: (task: TrackedTask) => Promise<Record<string, unknown>>): void {
    this.taskHandler = handler;
  }

  /**
   * Start worker mode — periodically poll connected peers for tasks.
   * sendPollFn: sends a "task_poll" message to a peer and returns queued tasks.
   */
  startWorker(
    intervalMs: number,
    pollFn: () => Promise<TrackedTask | null>,
    executeFn: (task: TrackedTask) => Promise<{ output?: Record<string, unknown>; error?: string }>
  ): void {
    this.workerTimer = setInterval(async () => {
      if (this.getActiveTasks() >= this.maxTasks) return; // at capacity

      try {
        const task = await pollFn();
        if (!task) return;

        this.tasks.set(task.task_id, task);
        this.updateTaskStatus(task.task_id, "running");
        console.error(`[Worker] Executing: ${task.task_id} type=${task.request.type}`);

        const result = await executeFn(task);
        if (result.error) {
          this.updateTaskStatus(task.task_id, "failed");
          this.emit("worker:task_failed", { task, error: result.error });
        } else {
          const taskResult: TaskResult = {
            task_id: task.task_id,
            status: "completed",
            output: result.output,
            duration_ms: Date.now() - task.created_at,
          };
          this.updateTaskStatus(task.task_id, "completed", taskResult);
          this.emit("worker:task_completed", { task, result: taskResult });
        }
      } catch (err) {
        console.error(`[Worker] Poll/execute error: ${(err as Error).message}`);
      }
    }, intervalMs);
    console.error(`[Worker] Started (polling every ${intervalMs / 1000}s)`);
  }

  stopWorker(): void {
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
      console.error("[Worker] Stopped");
    }
  }

  // --- Heartbeat ---

  buildHeartbeat(): Heartbeat {
    return {
      agent_id: this.agentId,
      status: this.getActiveTasks() >= this.maxTasks ? "overloaded"
        : this.getActiveTasks() > 0 ? "busy" : "idle",
      capabilities: this.capabilities,
      active_tasks: this.getActiveTasks(),
      max_tasks: this.maxTasks,
      uptime_ms: Date.now() - this.startTime,
      timestamp: new Date().toISOString(),
    };
  }

  startHeartbeat(intervalMs: number, broadcastFn: (hb: Heartbeat) => void): void {
    this.heartbeatTimer = setInterval(() => {
      broadcastFn(this.buildHeartbeat());
    }, intervalMs);
    console.error(`[TaskMgr] Heartbeat started (every ${intervalMs / 1000}s)`);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  destroy(): void {
    this.stopHeartbeat();
    this.tasks.clear();
    this.peerConfigs.clear();
  }
}
