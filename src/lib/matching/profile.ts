/**
 * ProfileManager — manages local agent profile and caches peer profiles.
 *
 * Responsibilities:
 *   - Maintains the local agent's structured skill profile
 *   - Caches peer profiles received via heartbeats
 *   - Finds matching peers for a set of required skills
 *   - Upgrades skill levels based on task completion history
 */

import { EventEmitter } from "events";
import { SkillMatcher } from "./matcher";
import type { ReputationManager } from "../reputation/manager";
import type {
  AgentId,
  AgentProfile,
  MatchResult,
  SkillEntry,
  SkillLevel,
  CapabilityTier,
} from "../../types/protocol";

export interface TaskTypeHistory {
  completions: number;
  successes: number;
}

export class ProfileManager extends EventEmitter {
  private localProfile: AgentProfile;
  private peerProfiles = new Map<string, AgentProfile>();
  private matcher = new SkillMatcher();
  private reputation: ReputationManager;

  constructor(agentId: AgentId, reputation: ReputationManager) {
    super();
    this.reputation = reputation;
    this.localProfile = {
      agent_id: agentId,
      skills: [],
      task_types: [],
      availability: "available",
      updated_at: new Date().toISOString(),
    };
  }

  // ============================================================
  // Local Profile
  // ============================================================

  getLocalProfile(): AgentProfile {
    return { ...this.localProfile, skills: [...this.localProfile.skills] };
  }

  updateSkills(skills: SkillEntry[]): void {
    this.localProfile.skills = [...skills];
    this.localProfile.updated_at = new Date().toISOString();
    this.emit("profile:updated", this.localProfile);
  }

  setAvailability(availability: AgentProfile["availability"]): void {
    this.localProfile.availability = availability;
    this.localProfile.updated_at = new Date().toISOString();
  }

  setCapabilityTier(tier: CapabilityTier): void {
    this.localProfile.capability_tier = tier;
    this.localProfile.updated_at = new Date().toISOString();
  }

  setTaskTypes(types: string[]): void {
    this.localProfile.task_types = types;
    this.localProfile.updated_at = new Date().toISOString();
  }

  // ============================================================
  // Peer Profile Cache
  // ============================================================

  updatePeerProfile(profile: AgentProfile): void {
    this.peerProfiles.set(profile.agent_id, profile);
    this.emit("peer:profile_updated", profile);
  }

  getPeerProfile(agentId: AgentId): AgentProfile | null {
    return this.peerProfiles.get(agentId) ?? null;
  }

  getAllPeerProfiles(): AgentProfile[] {
    return Array.from(this.peerProfiles.values());
  }

  removePeerProfile(agentId: AgentId): void {
    this.peerProfiles.delete(agentId);
  }

  // ============================================================
  // Matching
  // ============================================================

  /**
   * Find peers matching the required skills, sorted by match score descending.
   * Filters out offline peers.
   */
  findMatchingPeers(
    required: SkillEntry[],
    minScore = 0
  ): MatchResult[] {
    const results: MatchResult[] = [];

    for (const profile of this.peerProfiles.values()) {
      if (profile.availability === "offline") continue;

      const result = this.matcher.matchScore(required, profile);
      if (result.score > minScore) {
        results.push(result);
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Get match score for a specific peer against required skills.
   */
  getMatchScore(agentId: AgentId, required: SkillEntry[]): number {
    const profile = this.peerProfiles.get(agentId);
    if (!profile) return 0;
    return this.matcher.matchScore(required, profile).score;
  }

  // ============================================================
  // Skill Level Upgrade from Task History
  // ============================================================

  /**
   * Upgrade local skill levels based on task completion history.
   *
   * Rules:
   *   - 10+ completions with 90%+ success rate → level 3 (expert)
   *   - 5+ completions with 70%+ success rate → level 2 (intermediate)
   *   - Otherwise keep current level
   */
  upgradeSkillsFromHistory(history: Record<string, TaskTypeHistory>): void {
    let changed = false;

    // Aggregate total completions and success rate
    let totalCompletions = 0;
    let totalSuccesses = 0;
    for (const h of Object.values(history)) {
      totalCompletions += h.completions;
      totalSuccesses += h.successes;
    }

    if (totalCompletions === 0) return;

    const successRate = totalSuccesses / totalCompletions;

    for (const skill of this.localProfile.skills) {
      let newLevel: SkillLevel = skill.level;

      if (totalCompletions >= 10 && successRate >= 0.9) {
        newLevel = 3;
      } else if (totalCompletions >= 5 && successRate >= 0.7) {
        newLevel = 2;
      }

      if (newLevel > skill.level) {
        skill.level = newLevel;
        changed = true;
      }
    }

    if (changed) {
      this.localProfile.updated_at = new Date().toISOString();
      this.emit("profile:skills_upgraded", this.localProfile);
    }
  }

  // ============================================================
  // Cleanup
  // ============================================================

  destroy(): void {
    this.peerProfiles.clear();
    this.removeAllListeners();
  }
}
