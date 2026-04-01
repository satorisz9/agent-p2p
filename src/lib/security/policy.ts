/**
 * TaskPolicyManager — worker-side task access control.
 *
 * Combines:
 *   1. Policy check: is the task type allowed? Is the peer permitted?
 *   2. Content scan: does the task contain dangerous patterns?
 *
 * Supports:
 *   - Global default policy
 *   - Per-peer policy overrides (trusted peers get more access)
 *   - scan_only mode (audit mode — log but don't block)
 */

import { EventEmitter } from "events";
import { TaskScanner } from "./scanner";
import type {
  AgentId,
  TaskPolicy,
  TaskRequest,
  TaskCheckResult,
  ThreatEntry,
} from "../../types/protocol";

const DEFAULT_POLICY: TaskPolicy = {
  allowed_types: ["code_review", "generate", "run_tests", "transform", "report", "diagnose", "monitor", "deploy"],
  blocked_paths: [
    "~/.ssh",
    "~/.aws",
    "~/.gnupg",
    "~/.kube",
    "~/.docker/config",
    "~/.config/gcloud",
    "~/.azure",
    "/etc/shadow",
    "/etc/gshadow",
    ".env",
    ".env.local",
    ".env.production",
  ],
  blocked_env_patterns: [
    "*KEY*",
    "*SECRET*",
    "*TOKEN*",
    "*PASSWORD*",
    "*CREDENTIAL*",
  ],
  allow_outbound_network: false,
  max_output_bytes: 1_048_576, // 1MB
  scan_only: false,
};

export class TaskPolicyManager extends EventEmitter {
  private agentId: AgentId;
  private policy: TaskPolicy;
  private peerOverrides = new Map<string, Partial<TaskPolicy>>();
  private scanner = new TaskScanner();

  constructor(agentId: AgentId, policy?: Partial<TaskPolicy>) {
    super();
    this.agentId = agentId;
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  // ============================================================
  // Policy Management
  // ============================================================

  getPolicy(): TaskPolicy {
    return { ...this.policy };
  }

  updatePolicy(update: Partial<TaskPolicy>): void {
    this.policy = { ...this.policy, ...update };
    this.emit("policy:updated", this.policy);
  }

  setPeerOverride(peerId: AgentId, override: Partial<TaskPolicy>): void {
    this.peerOverrides.set(peerId, override);
  }

  removePeerOverride(peerId: AgentId): void {
    this.peerOverrides.delete(peerId);
  }

  /** Get effective policy for a specific peer (default + override) */
  getPolicyForPeer(peerId: AgentId): TaskPolicy {
    const override = this.peerOverrides.get(peerId);
    if (!override) return this.getPolicy();
    return { ...this.policy, ...override };
  }

  // ============================================================
  // Task Checking
  // ============================================================

  /**
   * Check whether a task from a peer should be accepted.
   * Performs both policy check and content scan.
   */
  checkTask(from: AgentId, task: TaskRequest): TaskCheckResult {
    const policy = this.getPolicyForPeer(from);
    const threats: ThreatEntry[] = [];

    // 1. Check task type
    if (!policy.allowed_types.includes(task.type)) {
      const result: TaskCheckResult = {
        allowed: false,
        reason: `Task type "${task.type}" not in allowed types: [${policy.allowed_types.join(", ")}]`,
        threats: [],
      };
      this.emit("policy:rejected", { from, task, result });
      return result;
    }

    // 2. Scan task content for threats
    const scanResult = this.scanner.scan(task);
    threats.push(...scanResult.threats);

    // 3. Check blocked paths in input
    const pathThreats = this.checkBlockedPaths(task.input, policy.blocked_paths, "input");
    threats.push(...pathThreats);

    // Decision
    if (threats.length > 0) {
      if (policy.scan_only) {
        // Audit mode: allow but report
        const result: TaskCheckResult = {
          allowed: true,
          threats,
          scan_only: true,
        };
        this.emit("policy:audit", { from, task, result });
        return result;
      }

      const result: TaskCheckResult = {
        allowed: false,
        reason: `Security scan detected ${threats.length} threat(s): ${threats.map(t => t.pattern).join(", ")}`,
        threats,
      };
      this.emit("policy:rejected", { from, task, result });
      return result;
    }

    return { allowed: true, threats: [] };
  }

  // ============================================================
  // Helpers
  // ============================================================

  /** Check if any string in the input contains a blocked path */
  private checkBlockedPaths(
    value: unknown,
    blockedPaths: string[],
    path: string
  ): ThreatEntry[] {
    const threats: ThreatEntry[] = [];

    if (typeof value === "string") {
      for (const blocked of blockedPaths) {
        if (value.includes(blocked)) {
          threats.push({
            category: "credential_access",
            pattern: `blocked path: ${blocked}`,
            matched_text: value.slice(0, 100),
            location: path,
          });
        }
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        threats.push(...this.checkBlockedPaths(value[i], blockedPaths, `${path}[${i}]`));
      }
    } else if (value && typeof value === "object") {
      for (const [key, val] of Object.entries(value)) {
        threats.push(...this.checkBlockedPaths(val, blockedPaths, `${path}.${key}`));
      }
    }

    return threats;
  }

  // ============================================================
  // Serialization
  // ============================================================

  serialize(): { policy: TaskPolicy; overrides: Record<string, Partial<TaskPolicy>> } {
    const overrides: Record<string, Partial<TaskPolicy>> = {};
    for (const [k, v] of this.peerOverrides) {
      overrides[k] = v;
    }
    return { policy: this.policy, overrides };
  }

  load(data: { policy?: TaskPolicy; overrides?: Record<string, Partial<TaskPolicy>> }): void {
    if (data.policy) this.policy = { ...DEFAULT_POLICY, ...data.policy };
    if (data.overrides) {
      for (const [k, v] of Object.entries(data.overrides)) {
        this.peerOverrides.set(k, v);
      }
    }
  }

  destroy(): void {
    this.peerOverrides.clear();
    this.removeAllListeners();
  }
}
