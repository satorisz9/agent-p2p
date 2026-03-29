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
