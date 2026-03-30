import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ReputationManager } from "../src/lib/reputation/manager";
import type { AgentId } from "../src/types/protocol";

const PEER_A = "agent:org1:alice" as AgentId;
const PEER_B = "agent:org2:bob" as AgentId;

describe("ReputationManager", () => {
  let rep: ReputationManager;

  beforeEach(() => {
    rep = new ReputationManager();
  });

  // --- Initial state ---

  it("returns 0.5 (neutral) for unknown peer", () => {
    assert.equal(rep.getScore(PEER_A), 0.5);
  });

  it("returns null record for unknown peer", () => {
    assert.equal(rep.getRecord(PEER_A), null);
  });

  // --- Task completion ---

  it("increases score after task completion", () => {
    rep.recordTaskCompleted(PEER_A, 100, 500);
    const record = rep.getRecord(PEER_A)!;
    assert.ok(record);
    assert.equal(record.tasks_completed, 1);
    assert.ok(record.score >= 0.5, `score ${record.score} should be >= 0.5 after completion`);
  });

  it("tracks running average of response and execution times", () => {
    rep.recordTaskCompleted(PEER_A, 100, 500);
    rep.recordTaskCompleted(PEER_A, 200, 1000);
    const record = rep.getRecord(PEER_A)!;
    assert.equal(record.avg_response_ms, 150);
    assert.equal(record.avg_execution_ms, 750);
  });

  it("score improves with multiple completions", () => {
    rep.recordTaskCompleted(PEER_A, 100, 500);
    const s1 = rep.getScore(PEER_A);
    rep.recordTaskCompleted(PEER_A, 100, 500);
    rep.recordTaskCompleted(PEER_A, 100, 500);
    const s3 = rep.getScore(PEER_A);
    assert.ok(s3 >= s1, `score after 3 completions (${s3}) should be >= after 1 (${s1})`);
  });

  // --- Task failure ---

  it("decreases score after task failure", () => {
    // First build up some score
    rep.recordTaskCompleted(PEER_A, 100, 500);
    const before = rep.getScore(PEER_A);
    rep.recordTaskFailed(PEER_A);
    const after = rep.getScore(PEER_A);
    assert.ok(after < before, `score after failure (${after}) should be < before (${before})`);
  });

  it("tracks failure count", () => {
    rep.recordTaskFailed(PEER_A);
    rep.recordTaskFailed(PEER_A);
    const record = rep.getRecord(PEER_A)!;
    assert.equal(record.tasks_failed, 2);
  });

  // --- Cancellation ---

  it("decreases score after cancellation (less than failure)", () => {
    for (let i = 0; i < 5; i++) rep.recordTaskCompleted(PEER_A, 100, 500);
    const before = rep.getScore(PEER_A);

    // Create a parallel peer with same history but record failure instead
    for (let i = 0; i < 5; i++) rep.recordTaskCompleted(PEER_B, 100, 500);

    rep.recordTaskCancelled(PEER_A);
    rep.recordTaskFailed(PEER_B);

    const afterCancel = rep.getScore(PEER_A);
    const afterFail = rep.getScore(PEER_B);
    assert.ok(afterCancel < before, "cancellation should lower score");
    assert.ok(afterCancel > afterFail, `cancel penalty (${afterCancel}) should be less than fail penalty (${afterFail})`);
  });

  // --- Disputes ---

  it("heavily penalizes disputes", () => {
    for (let i = 0; i < 5; i++) rep.recordTaskCompleted(PEER_A, 100, 500);
    const before = rep.getScore(PEER_A);
    rep.recordDispute(PEER_A);
    const after = rep.getScore(PEER_A);
    assert.ok(after < before, `dispute should lower score: ${after} < ${before}`);
    assert.equal(rep.getRecord(PEER_A)!.disputes, 1);
  });

  // --- Verified proofs ---

  it("gives bonus for verified proofs", () => {
    rep.recordTaskCompleted(PEER_A, 100, 500);
    const before = rep.getScore(PEER_A);
    rep.recordVerifiedProof(PEER_A);
    const after = rep.getScore(PEER_A);
    assert.ok(after >= before, `proof bonus should not lower score: ${after} >= ${before}`);
    assert.equal(rep.getRecord(PEER_A)!.verified_proofs, 1);
  });

  // --- Score bounds ---

  it("score never exceeds 1.0", () => {
    for (let i = 0; i < 100; i++) {
      rep.recordTaskCompleted(PEER_A, 50, 200);
      rep.recordVerifiedProof(PEER_A);
    }
    assert.ok(rep.getScore(PEER_A) <= 1.0);
  });

  it("score never goes below 0.0", () => {
    for (let i = 0; i < 100; i++) {
      rep.recordTaskFailed(PEER_A);
      rep.recordDispute(PEER_A);
    }
    assert.ok(rep.getScore(PEER_A) >= 0.0);
  });

  // --- History ---

  it("records score history with reasons", () => {
    rep.recordTaskCompleted(PEER_A, 100, 500);
    rep.recordTaskFailed(PEER_A);
    const history = rep.getRecord(PEER_A)!.history;
    assert.equal(history.length, 2);
    assert.equal(history[0].reason, "task_completed");
    assert.equal(history[1].reason, "task_failed");
  });

  it("caps history at 100 entries", () => {
    for (let i = 0; i < 120; i++) {
      rep.recordTaskCompleted(PEER_A, 100, 500);
    }
    assert.ok(rep.getRecord(PEER_A)!.history.length <= 100);
  });

  // --- Auto-permission suggestion ---

  it("emits demotion suggestion when score drops below threshold", () => {
    let suggestion: any = null;
    rep.on("reputation:mode_suggestion", (s) => { suggestion = s; });

    // Set low threshold and low min_interactions
    rep.setPolicy({ demote_threshold: 0.4, min_interactions: 3 });

    // Record enough failures to trigger
    rep.recordTaskFailed(PEER_A);
    rep.recordTaskFailed(PEER_A);
    rep.recordTaskFailed(PEER_A);

    assert.ok(suggestion, "should emit mode_suggestion");
    assert.equal(suggestion.agent_id, PEER_A);
    assert.equal(suggestion.suggested_mode, "readonly");
  });

  it("emits promotion suggestion when score rises above threshold", () => {
    let suggestion: any = null;
    rep.on("reputation:mode_suggestion", (s) => { suggestion = s; });

    rep.setPolicy({ promote_threshold: 0.7, min_interactions: 3 });

    rep.recordTaskCompleted(PEER_A, 100, 500);
    rep.recordTaskCompleted(PEER_A, 100, 500);
    rep.recordTaskCompleted(PEER_A, 100, 500);

    assert.ok(suggestion, "should emit mode_suggestion");
    assert.equal(suggestion.suggested_mode, "open");
  });

  it("does NOT emit suggestion before min_interactions", () => {
    let suggestion: any = null;
    rep.on("reputation:mode_suggestion", (s) => { suggestion = s; });

    rep.setPolicy({ demote_threshold: 0.4, min_interactions: 10 });

    rep.recordTaskFailed(PEER_A);
    rep.recordTaskFailed(PEER_A);
    rep.recordTaskFailed(PEER_A);

    assert.equal(suggestion, null, "should not suggest before min_interactions");
  });

  // --- Serialization ---

  it("serializes and loads state correctly", () => {
    rep.recordTaskCompleted(PEER_A, 100, 500);
    rep.recordTaskFailed(PEER_B);

    const data = rep.serialize();
    const rep2 = new ReputationManager();
    rep2.load(data);

    assert.equal(rep2.getScore(PEER_A), rep.getScore(PEER_A));
    assert.equal(rep2.getRecord(PEER_B)!.tasks_failed, 1);
  });

  // --- Multiple peers ---

  it("tracks peers independently", () => {
    rep.recordTaskCompleted(PEER_A, 100, 500);
    rep.recordTaskFailed(PEER_B);

    assert.ok(rep.getScore(PEER_A) > rep.getScore(PEER_B));
    assert.equal(rep.listRecords().length, 2);
  });
});
