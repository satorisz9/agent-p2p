/**
 * Reputation Manager — tracks peer trust scores based on task outcomes.
 *
 * Scoring model:
 *   - Base score starts at 0.5 (neutral)
 *   - Each completed task: +weight (decayed by recency)
 *   - Each failed task: -weight * 1.5 (failures penalized more)
 *   - Each dispute: -weight * 2.0
 *   - Verified proofs: +bonus
 *   - Score clamped to [0.0, 1.0]
 *
 * Auto-permission adjustment:
 *   - Score < demote_threshold → peer demoted to readonly
 *   - Score > promote_threshold → peer promoted to open (if min_interactions met)
 */

import { EventEmitter } from "events";
import type {
  AgentId,
  ReputationRecord,
  ReputationSnapshot,
  ReputationPolicy,
  ConnectionMode,
} from "../../types/protocol";

const DEFAULT_POLICY: ReputationPolicy = {
  demote_threshold: 0.3,
  promote_threshold: 0.8,
  min_interactions: 5,
  recency_decay: 0.95,
};

export class ReputationManager extends EventEmitter {
  private records = new Map<string, ReputationRecord>();
  private policy: ReputationPolicy;

  constructor(policy?: Partial<ReputationPolicy>) {
    super();
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  // --- Query ---

  getRecord(agentId: AgentId): ReputationRecord | null {
    return this.records.get(agentId) ?? null;
  }

  getScore(agentId: AgentId): number {
    return this.records.get(agentId)?.score ?? 0.5;
  }

  listRecords(): ReputationRecord[] {
    return Array.from(this.records.values());
  }

  getPolicy(): ReputationPolicy {
    return { ...this.policy };
  }

  setPolicy(policy: Partial<ReputationPolicy>): void {
    this.policy = { ...this.policy, ...policy };
  }

  // --- Event Recording ---

  /** Record a successful task completion */
  recordTaskCompleted(agentId: AgentId, responseMs: number, executionMs: number): void {
    const record = this.ensureRecord(agentId);
    record.tasks_completed++;
    record.avg_response_ms = this.runningAvg(record.avg_response_ms, responseMs, record.tasks_completed);
    record.avg_execution_ms = this.runningAvg(record.avg_execution_ms, executionMs, record.tasks_completed);
    record.last_interaction = new Date().toISOString();
    this.recalculateScore(record, "task_completed");
    this.checkThresholds(record);
  }

  /** Record a task failure */
  recordTaskFailed(agentId: AgentId): void {
    const record = this.ensureRecord(agentId);
    record.tasks_failed++;
    record.last_interaction = new Date().toISOString();
    this.recalculateScore(record, "task_failed");
    this.checkThresholds(record);
  }

  /** Record a task cancellation by the peer */
  recordTaskCancelled(agentId: AgentId): void {
    const record = this.ensureRecord(agentId);
    record.tasks_cancelled++;
    record.last_interaction = new Date().toISOString();
    this.recalculateScore(record, "task_cancelled");
    this.checkThresholds(record);
  }

  /** Record a dispute against a peer */
  recordDispute(agentId: AgentId): void {
    const record = this.ensureRecord(agentId);
    record.disputes++;
    record.last_interaction = new Date().toISOString();
    this.recalculateScore(record, "dispute");
    this.checkThresholds(record);
  }

  /** Record a verified execution proof */
  recordVerifiedProof(agentId: AgentId): void {
    const record = this.ensureRecord(agentId);
    record.verified_proofs++;
    record.last_interaction = new Date().toISOString();
    this.recalculateScore(record, "verified_proof");
    this.checkThresholds(record);
  }

  // --- Scoring ---

  private recalculateScore(record: ReputationRecord, reason: string): void {
    const total = record.tasks_completed + record.tasks_failed + record.tasks_cancelled;
    if (total === 0) {
      record.score = 0.5;
      return;
    }

    // Completion ratio (0-1)
    const completionRatio = record.tasks_completed / total;

    // Failure penalty (failures + cancellations weighted higher)
    const failPenalty = (record.tasks_failed * 1.5 + record.tasks_cancelled * 0.5) / total;

    // Dispute penalty (heavy)
    const disputePenalty = Math.min(record.disputes * 0.1, 0.5);

    // Proof bonus
    const proofBonus = record.verified_proofs > 0
      ? Math.min(record.verified_proofs / record.tasks_completed * 0.1, 0.1)
      : 0;

    // Weighted score
    let score = 0.5 * completionRatio    // base from completion rate
              + 0.3 * (1 - failPenalty)   // penalty from failures
              + 0.1 * (1 - disputePenalty) // penalty from disputes
              + 0.1 * (0.5 + proofBonus); // bonus from verified proofs

    // Apply recency decay to history influence
    if (record.history.length > 0) {
      const recentScores = record.history.slice(-10);
      let recentAvg = 0;
      let weight = 1;
      let totalWeight = 0;
      for (let i = recentScores.length - 1; i >= 0; i--) {
        recentAvg += recentScores[i].score * weight;
        totalWeight += weight;
        weight *= this.policy.recency_decay;
      }
      recentAvg /= totalWeight;
      // Blend current calculation with recent trend (70/30)
      score = score * 0.7 + recentAvg * 0.3;
    }

    record.score = Math.max(0, Math.min(1, score));
    record.history.push({
      timestamp: new Date().toISOString(),
      score: record.score,
      reason,
    });

    // Keep history bounded
    if (record.history.length > 100) {
      record.history = record.history.slice(-100);
    }
  }

  private checkThresholds(record: ReputationRecord): void {
    const totalInteractions = record.tasks_completed + record.tasks_failed + record.tasks_cancelled;
    if (totalInteractions < this.policy.min_interactions) return;

    let suggestedMode: ConnectionMode | null = null;

    if (record.score < this.policy.demote_threshold) {
      suggestedMode = "readonly";
    } else if (record.score > this.policy.promote_threshold) {
      suggestedMode = "open";
    }

    if (suggestedMode) {
      this.emit("reputation:mode_suggestion", {
        agent_id: record.agent_id,
        score: record.score,
        suggested_mode: suggestedMode,
        reason: suggestedMode === "readonly"
          ? `Score ${record.score.toFixed(3)} below demote threshold ${this.policy.demote_threshold}`
          : `Score ${record.score.toFixed(3)} above promote threshold ${this.policy.promote_threshold}`,
      });
    }
  }

  // --- Helpers ---

  private ensureRecord(agentId: AgentId): ReputationRecord {
    let record = this.records.get(agentId);
    if (!record) {
      record = {
        agent_id: agentId,
        tasks_completed: 0,
        tasks_failed: 0,
        tasks_cancelled: 0,
        avg_response_ms: 0,
        avg_execution_ms: 0,
        score: 0.5,
        disputes: 0,
        verified_proofs: 0,
        last_interaction: new Date().toISOString(),
        history: [],
      };
      this.records.set(agentId, record);
    }
    return record;
  }

  private runningAvg(current: number, newValue: number, count: number): number {
    if (count <= 1) return newValue;
    return current + (newValue - current) / count;
  }

  // --- Serialization ---

  serialize(): Record<string, ReputationRecord> {
    const result: Record<string, ReputationRecord> = {};
    for (const [key, val] of this.records) {
      result[key] = val;
    }
    return result;
  }

  load(data: Record<string, ReputationRecord>): void {
    this.records.clear();
    for (const [key, val] of Object.entries(data)) {
      this.records.set(key, val);
    }
  }

  destroy(): void {
    this.records.clear();
    this.removeAllListeners();
  }
}
