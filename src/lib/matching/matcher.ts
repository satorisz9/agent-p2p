/**
 * SkillMatcher — scores how well an agent's profile matches task requirements.
 *
 * Scoring:
 *   1. Exact skill match: full credit (1.0 if level >= required)
 *   2. Similar skill match: partial credit (0.7 × level factor)
 *   3. Same domain only: small credit (0.2)
 *   4. No match: 0
 *
 * Final score = average across all required skills.
 */

import type { AgentProfile, MatchResult, SkillEntry } from "../../types/protocol";

/** Bidirectional similarity groups — skills in the same group are considered related */
const SIMILARITY_GROUPS: string[][] = [
  ["react", "nextjs", "preact", "remix", "gatsby"],
  ["vue", "nuxt"],
  ["angular", "rxjs"],
  ["python", "fastapi", "django", "flask", "pytorch", "tensorflow"],
  ["typescript", "javascript", "nodejs", "deno", "bun"],
  ["rust", "wasm"],
  ["go", "gin", "echo"],
  ["java", "spring", "kotlin"],
  ["ruby", "rails"],
  ["postgresql", "mysql", "sqlite", "mariadb"],
  ["mongodb", "redis", "dynamodb"],
  ["docker", "kubernetes", "podman"],
  ["terraform", "pulumi", "cloudformation"],
  ["aws", "gcp", "azure"],
  ["react-native", "flutter", "swift", "kotlin-mobile"],
];

/** Pre-built lookup: skill → set of similar skills */
const similarityMap = new Map<string, Set<string>>();

for (const group of SIMILARITY_GROUPS) {
  for (const skill of group) {
    const existing = similarityMap.get(skill) ?? new Set<string>();
    for (const other of group) {
      if (other !== skill) existing.add(other);
    }
    similarityMap.set(skill, existing);
  }
}

const SIMILAR_CREDIT = 0.7;
const DOMAIN_ONLY_CREDIT = 0.2;

export class SkillMatcher {
  /**
   * Score how well a profile matches a set of required skills.
   * Returns a MatchResult with overall score (0–1) and per-skill breakdown.
   */
  matchScore(required: SkillEntry[], profile: AgentProfile): MatchResult {
    if (required.length === 0) {
      return { agent_id: profile.agent_id, score: 1.0, skill_matches: [] };
    }

    const skillMatches: MatchResult["skill_matches"] = [];

    for (const req of required) {
      const best = this.bestMatch(req, profile.skills);
      skillMatches.push(best);
    }

    const score = skillMatches.reduce((sum, m) => sum + m.score, 0) / skillMatches.length;

    return {
      agent_id: profile.agent_id,
      score: Math.round(score * 1000) / 1000, // 3 decimal places
      skill_matches: skillMatches,
    };
  }

  /** Find the best matching skill in the agent's profile for a single requirement */
  private bestMatch(
    required: SkillEntry,
    agentSkills: SkillEntry[]
  ): MatchResult["skill_matches"][0] {
    let bestScore = 0;
    let bestSkill: string | null = null;

    for (const agent of agentSkills) {
      let score = 0;

      if (agent.skill === required.skill) {
        // Exact match
        score = this.levelFactor(required.level, agent.level);
      } else if (this.isSimilar(required.skill, agent.skill)) {
        // Similar skill match
        score = SIMILAR_CREDIT * this.levelFactor(required.level, agent.level);
      } else if (agent.domain === required.domain) {
        // Same domain only
        score = DOMAIN_ONLY_CREDIT;
      }

      if (score > bestScore) {
        bestScore = score;
        bestSkill = agent.skill;
      }
    }

    return {
      required,
      matched_skill: bestSkill,
      score: Math.round(bestScore * 1000) / 1000,
    };
  }

  /** Level factor: 1.0 if agent >= required, otherwise proportional */
  private levelFactor(required: number, agent: number): number {
    if (agent >= required) return 1.0;
    return agent / required; // e.g. level 1 / required 3 = 0.333
  }

  /** Check if two skills are in the same similarity group */
  private isSimilar(a: string, b: string): boolean {
    return similarityMap.get(a)?.has(b) ?? false;
  }

  /** Expose similarity map for external use (e.g., adding custom similarities) */
  addSimilarity(skills: string[]): void {
    for (const skill of skills) {
      const existing = similarityMap.get(skill) ?? new Set<string>();
      for (const other of skills) {
        if (other !== skill) existing.add(other);
      }
      similarityMap.set(skill, existing);
    }
  }
}
