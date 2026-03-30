import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SkillMatcher } from "../src/lib/matching/matcher";
import { WorkspaceIntrospector } from "../src/lib/matching/introspect";
import { ProfileManager } from "../src/lib/matching/profile";
import { AuctionManager } from "../src/lib/marketplace/auction";
import { ReputationManager } from "../src/lib/reputation/manager";
import { EconomicManager } from "../src/lib/economic/wallet";
import { ExecutionVerifier } from "../src/lib/verification/prover";
import { generateKeyPair } from "../src/lib/crypto/keys";
import type { AgentId, AgentProfile, SkillEntry, TaskBid } from "../src/types/protocol";

const ISSUER = "agent:org1:issuer" as AgentId;
const WORKER_A = "agent:org2:alice" as AgentId;
const WORKER_B = "agent:org3:bob" as AgentId;
const WORKER_C = "agent:org4:carol" as AgentId;

// ============================================================
// SkillMatcher
// ============================================================

describe("SkillMatcher", () => {
  let matcher: SkillMatcher;

  beforeEach(() => {
    matcher = new SkillMatcher();
  });

  describe("exact skill match", () => {
    it("returns 1.0 when skill and level match exactly", () => {
      const required: SkillEntry[] = [{ domain: "coding", skill: "typescript", level: 2 }];
      const profile: AgentProfile = {
        agent_id: WORKER_A,
        skills: [{ domain: "coding", skill: "typescript", level: 2 }],
        task_types: [],
        availability: "available",
        updated_at: new Date().toISOString(),
      };
      const result = matcher.matchScore(required, profile);
      assert.equal(result.score, 1.0);
      assert.equal(result.skill_matches[0].score, 1.0);
    });

    it("returns 1.0 when agent level exceeds required", () => {
      const required: SkillEntry[] = [{ domain: "coding", skill: "typescript", level: 1 }];
      const profile: AgentProfile = {
        agent_id: WORKER_A,
        skills: [{ domain: "coding", skill: "typescript", level: 3 }],
        task_types: [],
        availability: "available",
        updated_at: new Date().toISOString(),
      };
      const result = matcher.matchScore(required, profile);
      assert.equal(result.score, 1.0);
    });

    it("penalizes when agent level is below required", () => {
      const required: SkillEntry[] = [{ domain: "coding", skill: "typescript", level: 3 }];
      const profile: AgentProfile = {
        agent_id: WORKER_A,
        skills: [{ domain: "coding", skill: "typescript", level: 1 }],
        task_types: [],
        availability: "available",
        updated_at: new Date().toISOString(),
      };
      const result = matcher.matchScore(required, profile);
      assert.ok(result.score > 0);
      assert.ok(result.score < 1.0);
    });
  });

  describe("similar skill matching", () => {
    it("matches react to nextjs via similarity map", () => {
      const required: SkillEntry[] = [{ domain: "coding", skill: "react", level: 2 }];
      const profile: AgentProfile = {
        agent_id: WORKER_A,
        skills: [{ domain: "coding", skill: "nextjs", level: 3 }],
        task_types: [],
        availability: "available",
        updated_at: new Date().toISOString(),
      };
      const result = matcher.matchScore(required, profile);
      assert.ok(result.score > 0.5, `Expected > 0.5 but got ${result.score}`);
      assert.equal(result.skill_matches[0].matched_skill, "nextjs");
    });

    it("matches python to fastapi via similarity map", () => {
      const required: SkillEntry[] = [{ domain: "coding", skill: "python", level: 2 }];
      const profile: AgentProfile = {
        agent_id: WORKER_A,
        skills: [{ domain: "coding", skill: "fastapi", level: 2 }],
        task_types: [],
        availability: "available",
        updated_at: new Date().toISOString(),
      };
      const result = matcher.matchScore(required, profile);
      assert.ok(result.score > 0.5);
    });

    it("returns 0 when no skills match at all", () => {
      const required: SkillEntry[] = [{ domain: "coding", skill: "rust", level: 2 }];
      const profile: AgentProfile = {
        agent_id: WORKER_A,
        skills: [{ domain: "design", skill: "figma", level: 3 }],
        task_types: [],
        availability: "available",
        updated_at: new Date().toISOString(),
      };
      const result = matcher.matchScore(required, profile);
      assert.equal(result.score, 0);
    });
  });

  describe("multi-skill matching", () => {
    it("averages scores across all required skills", () => {
      const required: SkillEntry[] = [
        { domain: "coding", skill: "typescript", level: 2 },
        { domain: "devops", skill: "docker", level: 1 },
      ];
      const profile: AgentProfile = {
        agent_id: WORKER_A,
        skills: [
          { domain: "coding", skill: "typescript", level: 3 },
          // no docker skill
        ],
        task_types: [],
        availability: "available",
        updated_at: new Date().toISOString(),
      };
      const result = matcher.matchScore(required, profile);
      // typescript matches perfectly (1.0), docker matches 0 → avg 0.5
      assert.equal(result.score, 0.5);
      assert.equal(result.skill_matches.length, 2);
    });
  });

  describe("domain-only matching", () => {
    it("gives partial credit for same domain different skill", () => {
      const required: SkillEntry[] = [{ domain: "coding", skill: "go", level: 2 }];
      const profile: AgentProfile = {
        agent_id: WORKER_A,
        skills: [{ domain: "coding", skill: "rust", level: 3 }],
        task_types: [],
        availability: "available",
        updated_at: new Date().toISOString(),
      };
      const result = matcher.matchScore(required, profile);
      // Same domain but different skill → small partial credit
      assert.ok(result.score > 0, "Should get partial credit for same domain");
      assert.ok(result.score <= 0.3, `Domain-only credit should be small, got ${result.score}`);
    });
  });
});

// ============================================================
// WorkspaceIntrospector
// ============================================================

describe("WorkspaceIntrospector", () => {
  describe("parsePackageJson", () => {
    it("detects typescript from devDependencies", () => {
      const skills = WorkspaceIntrospector.parsePackageJson({
        devDependencies: { typescript: "^5" },
      });
      assert.ok(skills.some(s => s.skill === "typescript"));
    });

    it("detects react from dependencies", () => {
      const skills = WorkspaceIntrospector.parsePackageJson({
        dependencies: { react: "^19", "react-dom": "^19" },
      });
      assert.ok(skills.some(s => s.skill === "react"));
    });

    it("detects next.js", () => {
      const skills = WorkspaceIntrospector.parsePackageJson({
        dependencies: { next: "16.2.1" },
      });
      assert.ok(skills.some(s => s.skill === "nextjs"));
    });

    it("detects express", () => {
      const skills = WorkspaceIntrospector.parsePackageJson({
        dependencies: { express: "^4" },
      });
      assert.ok(skills.some(s => s.skill === "express"));
    });

    it("returns empty for empty package.json", () => {
      const skills = WorkspaceIntrospector.parsePackageJson({});
      assert.equal(skills.length, 0);
    });
  });

  describe("parseRequirementsTxt", () => {
    it("detects python/fastapi from requirements", () => {
      const skills = WorkspaceIntrospector.parseRequirementsTxt(
        "fastapi>=0.100\nuvicorn\npydantic"
      );
      assert.ok(skills.some(s => s.skill === "python"));
      assert.ok(skills.some(s => s.skill === "fastapi"));
    });

    it("detects pytorch", () => {
      const skills = WorkspaceIntrospector.parseRequirementsTxt("torch>=2.0\nnumpy");
      assert.ok(skills.some(s => s.skill === "pytorch"));
    });
  });

  describe("detectFromFiles", () => {
    it("detects docker from Dockerfile existence", () => {
      const skills = WorkspaceIntrospector.detectFromFiles(["Dockerfile", "docker-compose.yml"]);
      assert.ok(skills.some(s => s.skill === "docker"));
    });

    it("detects terraform", () => {
      const skills = WorkspaceIntrospector.detectFromFiles(["main.tf"]);
      assert.ok(skills.some(s => s.skill === "terraform"));
    });

    it("detects rust from Cargo.toml", () => {
      const skills = WorkspaceIntrospector.detectFromFiles(["Cargo.toml"]);
      assert.ok(skills.some(s => s.skill === "rust"));
    });

    it("detects go from go.mod", () => {
      const skills = WorkspaceIntrospector.detectFromFiles(["go.mod"]);
      assert.ok(skills.some(s => s.skill === "go"));
    });
  });
});

// ============================================================
// ProfileManager
// ============================================================

describe("ProfileManager", () => {
  let pm: ProfileManager;
  let rep: ReputationManager;

  beforeEach(() => {
    rep = new ReputationManager();
    pm = new ProfileManager(WORKER_A, rep);
  });

  describe("local profile", () => {
    it("creates a default profile", () => {
      const profile = pm.getLocalProfile();
      assert.equal(profile.agent_id, WORKER_A);
      assert.equal(profile.availability, "available");
    });

    it("updates skills", () => {
      pm.updateSkills([{ domain: "coding", skill: "typescript", level: 3 }]);
      const profile = pm.getLocalProfile();
      assert.equal(profile.skills.length, 1);
      assert.equal(profile.skills[0].skill, "typescript");
    });
  });

  describe("peer profile cache", () => {
    it("stores and retrieves peer profiles from heartbeat", () => {
      const peerProfile: AgentProfile = {
        agent_id: WORKER_B,
        skills: [{ domain: "coding", skill: "python", level: 2 }],
        task_types: ["code_review"],
        availability: "available",
        updated_at: new Date().toISOString(),
      };
      pm.updatePeerProfile(peerProfile);
      const retrieved = pm.getPeerProfile(WORKER_B);
      assert.deepEqual(retrieved, peerProfile);
    });

    it("returns null for unknown peer", () => {
      assert.equal(pm.getPeerProfile(WORKER_C), null);
    });
  });

  describe("findMatchingPeers", () => {
    it("returns peers sorted by match score", () => {
      pm.updatePeerProfile({
        agent_id: WORKER_B,
        skills: [{ domain: "coding", skill: "typescript", level: 3 }],
        task_types: [],
        availability: "available",
        updated_at: new Date().toISOString(),
      });
      pm.updatePeerProfile({
        agent_id: WORKER_C,
        skills: [{ domain: "coding", skill: "python", level: 2 }],
        task_types: [],
        availability: "available",
        updated_at: new Date().toISOString(),
      });

      const required: SkillEntry[] = [{ domain: "coding", skill: "typescript", level: 2 }];
      const matches = pm.findMatchingPeers(required);
      assert.equal(matches.length, 2);
      assert.equal(matches[0].agent_id, WORKER_B); // typescript expert → first
      assert.ok(matches[0].score > matches[1].score);
    });

    it("filters out offline peers", () => {
      pm.updatePeerProfile({
        agent_id: WORKER_B,
        skills: [{ domain: "coding", skill: "typescript", level: 3 }],
        task_types: [],
        availability: "offline",
        updated_at: new Date().toISOString(),
      });

      const required: SkillEntry[] = [{ domain: "coding", skill: "typescript", level: 2 }];
      const matches = pm.findMatchingPeers(required);
      assert.equal(matches.length, 0);
    });
  });

  describe("skill level upgrade from task history", () => {
    it("upgrades skill level based on completion count", () => {
      pm.updateSkills([{ domain: "coding", skill: "typescript", level: 1 }]);

      // Simulate 10 completions with 90%+ success rate
      for (let i = 0; i < 10; i++) {
        rep.recordTaskCompleted(WORKER_A, 100, 500);
      }
      rep.recordTaskFailed(WORKER_A); // 1 failure

      pm.upgradeSkillsFromHistory({ "code_review": { completions: 10, successes: 9 } });
      const profile = pm.getLocalProfile();
      // 90% success rate with 10+ completions → should upgrade
      assert.ok(profile.skills[0].level >= 2, `Expected level >= 2, got ${profile.skills[0].level}`);
    });
  });
});

// ============================================================
// AuctionManager + Skill Matching Integration
// ============================================================

describe("AuctionManager — Skill-Based Selection", () => {
  let auction: AuctionManager;
  let rep: ReputationManager;
  let eco: EconomicManager;
  let verifier: ExecutionVerifier;
  let profileMgr: ProfileManager;
  let issuerKeys: ReturnType<typeof generateKeyPair>;
  let tokenId: string;

  beforeEach(() => {
    rep = new ReputationManager();
    eco = new EconomicManager(ISSUER);
    verifier = new ExecutionVerifier();
    issuerKeys = generateKeyPair();
    profileMgr = new ProfileManager(ISSUER, rep);

    const token = eco.issueToken("WorkCoin", "WORK", 18, 100000, issuerKeys.privateKey, "key1");
    tokenId = token.token_id;

    auction = new AuctionManager({
      agentId: ISSUER,
      reputation: rep,
      economic: eco,
      verifier,
      profileManager: profileMgr,
    });
  });

  it("best_value strategy includes skill match score when required_skills set", () => {
    // Register peer profiles
    profileMgr.updatePeerProfile({
      agent_id: WORKER_A,
      skills: [{ domain: "coding", skill: "typescript", level: 3 }],
      task_types: [],
      availability: "available",
      updated_at: new Date().toISOString(),
    });
    profileMgr.updatePeerProfile({
      agent_id: WORKER_B,
      skills: [{ domain: "coding", skill: "python", level: 3 }],
      task_types: [],
      availability: "available",
      updated_at: new Date().toISOString(),
    });

    const record = auction.createAuction({
      type: "code_review",
      description: "Review TypeScript PR",
      input: {},
      budget: { token_id: tokenId, max_amount: 1000 },
      bid_deadline: new Date(Date.now() + 60000).toISOString(),
      selection: "best_value",
      required_skills: [{ domain: "coding", skill: "typescript", level: 2 }],
    });

    // Both bid same price, same reputation
    auction.submitBid(record.task_id, {
      task_id: record.task_id,
      bidder: WORKER_A,
      price: { token_id: tokenId, amount: 500 },
      estimated_duration_ms: 30000,
      reputation_score: 0.5,
      capabilities: [],
    });
    auction.submitBid(record.task_id, {
      task_id: record.task_id,
      bidder: WORKER_B,
      price: { token_id: tokenId, amount: 500 },
      estimated_duration_ms: 30000,
      reputation_score: 0.5,
      capabilities: [],
    });

    const winner = auction.selectWinner(record);
    assert.ok(winner, "Should select a winner");
    // WORKER_A has typescript skill → should win over WORKER_B (python)
    assert.equal(winner!.bidder, WORKER_A);
  });

  it("falls back to legacy behavior when no required_skills", () => {
    const record = auction.createAuction({
      type: "code_review",
      description: "Review PR",
      input: {},
      budget: { token_id: tokenId, max_amount: 1000 },
      bid_deadline: new Date(Date.now() + 60000).toISOString(),
      selection: "lowest_price",
    });

    auction.submitBid(record.task_id, {
      task_id: record.task_id,
      bidder: WORKER_A,
      price: { token_id: tokenId, amount: 800 },
      estimated_duration_ms: 30000,
      reputation_score: 0.5,
      capabilities: ["code_review"],
    });
    auction.submitBid(record.task_id, {
      task_id: record.task_id,
      bidder: WORKER_B,
      price: { token_id: tokenId, amount: 200 },
      estimated_duration_ms: 30000,
      reputation_score: 0.5,
      capabilities: ["code_review"],
    });

    const winner = auction.selectWinner(record);
    assert.equal(winner!.bidder, WORKER_B); // lowest price wins
  });
});
