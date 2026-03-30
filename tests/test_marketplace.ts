import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AuctionManager } from "../src/lib/marketplace/auction";
import { ReputationManager } from "../src/lib/reputation/manager";
import { EconomicManager } from "../src/lib/economic/wallet";
import { ExecutionVerifier } from "../src/lib/verification/prover";
import { generateKeyPair } from "../src/lib/crypto/keys";
import type { AgentId, TaskBid } from "../src/types/protocol";

const ISSUER = "agent:org1:issuer" as AgentId;
const WORKER_A = "agent:org2:alice" as AgentId;
const WORKER_B = "agent:org3:bob" as AgentId;
const WORKER_C = "agent:org4:carol" as AgentId;

describe("AuctionManager — Marketplace", () => {
  let auction: AuctionManager;
  let rep: ReputationManager;
  let eco: EconomicManager;
  let verifier: ExecutionVerifier;
  let issuerKeys: ReturnType<typeof generateKeyPair>;
  let workerAKeys: ReturnType<typeof generateKeyPair>;
  let tokenId: string;

  beforeEach(() => {
    rep = new ReputationManager();
    eco = new EconomicManager(ISSUER);
    verifier = new ExecutionVerifier();
    issuerKeys = generateKeyPair();
    workerAKeys = generateKeyPair();

    // Issue token and give issuer funds
    const token = eco.issueToken("WorkCoin", "WORK", 18, 100000, issuerKeys.privateKey, "key1");
    tokenId = token.token_id;

    auction = new AuctionManager({
      agentId: ISSUER,
      reputation: rep,
      economic: eco,
      verifier,
    });
  });

  function makeBroadcast(overrides: Record<string, any> = {}) {
    return {
      type: "code_review",
      description: "Review PR #42",
      input: { pr_url: "https://github.com/org/repo/pull/42" },
      budget: { token_id: tokenId, max_amount: 1000 },
      bid_deadline: new Date(Date.now() + 60000).toISOString(), // 1 min from now
      selection: "best_value" as const,
      ...overrides,
    };
  }

  function makeBid(bidder: AgentId, amount: number, overrides: Record<string, any> = {}): Omit<TaskBid, "bid_id" | "submitted_at"> {
    return {
      task_id: "", // will be ignored, auction.submitBid uses the taskId param
      bidder,
      price: { token_id: tokenId, amount },
      estimated_duration_ms: 30000,
      reputation_score: rep.getScore(bidder),
      capabilities: ["code_review"],
      ...overrides,
    };
  }

  // ============================================================
  // Auction Creation
  // ============================================================

  describe("Auction Creation", () => {
    it("creates an auction with open status", () => {
      const record = auction.createAuction(makeBroadcast());
      assert.ok(record.task_id.startsWith("task_"));
      assert.equal(record.status, "open");
      assert.equal(record.bids.length, 0);
      assert.equal(record.broadcast.type, "code_review");
    });

    it("emits auction:created event", () => {
      let emitted = false;
      auction.on("auction:created", () => { emitted = true; });
      auction.createAuction(makeBroadcast());
      assert.ok(emitted);
    });
  });

  // ============================================================
  // Bidding
  // ============================================================

  describe("Bidding", () => {
    it("accepts valid bids", () => {
      const record = auction.createAuction(makeBroadcast());
      const result = auction.submitBid(record.task_id, makeBid(WORKER_A, 500));
      assert.ok(result.success);
      assert.ok(result.bid!.bid_id.startsWith("bid_"));
      assert.equal(auction.getBidsForTask(record.task_id).length, 1);
    });

    it("accepts multiple bids from different agents", () => {
      const record = auction.createAuction(makeBroadcast());
      auction.submitBid(record.task_id, makeBid(WORKER_A, 500));
      auction.submitBid(record.task_id, makeBid(WORKER_B, 600));
      auction.submitBid(record.task_id, makeBid(WORKER_C, 400));
      assert.equal(auction.getBidsForTask(record.task_id).length, 3);
    });

    it("rejects duplicate bid from same agent", () => {
      const record = auction.createAuction(makeBroadcast());
      auction.submitBid(record.task_id, makeBid(WORKER_A, 500));
      const result = auction.submitBid(record.task_id, makeBid(WORKER_A, 300));
      assert.ok(!result.success);
      assert.ok(result.error!.includes("Already"));
    });

    it("rejects bid exceeding budget", () => {
      const record = auction.createAuction(makeBroadcast({ budget: { token_id: tokenId, max_amount: 100 } }));
      const result = auction.submitBid(record.task_id, makeBid(WORKER_A, 200));
      assert.ok(!result.success);
      assert.ok(result.error!.includes("exceeds budget"));
    });

    it("rejects bid with wrong token", () => {
      const record = auction.createAuction(makeBroadcast());
      const result = auction.submitBid(record.task_id, makeBid(WORKER_A, 500, {
        price: { token_id: "wrong:token", amount: 500 },
      }));
      assert.ok(!result.success);
      assert.ok(result.error!.includes("Token mismatch"));
    });

    it("rejects bid below minimum reputation", () => {
      const record = auction.createAuction(makeBroadcast({ min_reputation: 0.9 }));
      // WORKER_A has default 0.5 reputation
      const result = auction.submitBid(record.task_id, makeBid(WORKER_A, 500));
      assert.ok(!result.success);
      assert.ok(result.error!.includes("Reputation"));
    });

    it("accepts bid when reputation meets minimum", () => {
      // Build up WORKER_A reputation
      for (let i = 0; i < 10; i++) rep.recordTaskCompleted(WORKER_A, 100, 500);
      const record = auction.createAuction(makeBroadcast({ min_reputation: 0.7 }));
      const result = auction.submitBid(record.task_id, makeBid(WORKER_A, 500));
      assert.ok(result.success, `should accept: score=${rep.getScore(WORKER_A)}`);
    });

    it("rejects bid with missing capabilities", () => {
      const record = auction.createAuction(makeBroadcast({ required_capabilities: ["ml_training", "code_review"] }));
      const result = auction.submitBid(record.task_id, makeBid(WORKER_A, 500, {
        capabilities: ["code_review"],  // missing ml_training
      }));
      assert.ok(!result.success);
      assert.ok(result.error!.includes("ml_training"));
    });

    it("rejects bid on closed auction", () => {
      const record = auction.createAuction(makeBroadcast());
      auction.submitBid(record.task_id, makeBid(WORKER_A, 500));
      auction.closeBidding(record.task_id);
      const result = auction.submitBid(record.task_id, makeBid(WORKER_B, 300));
      assert.ok(!result.success);
    });

    it("emits bid_received event", () => {
      let received: any = null;
      auction.on("auction:bid_received", (e) => { received = e; });
      const record = auction.createAuction(makeBroadcast());
      auction.submitBid(record.task_id, makeBid(WORKER_A, 500));
      assert.ok(received);
      assert.equal(received.task_id, record.task_id);
    });
  });

  // ============================================================
  // Bid Selection Strategies
  // ============================================================

  describe("Selection Strategies", () => {
    it("lowest_price: selects cheapest bid", () => {
      const record = auction.createAuction(makeBroadcast({ selection: "lowest_price" }));
      auction.submitBid(record.task_id, makeBid(WORKER_A, 800));
      auction.submitBid(record.task_id, makeBid(WORKER_B, 300));
      auction.submitBid(record.task_id, makeBid(WORKER_C, 600));

      const winner = auction.selectWinner(auction.getAuction(record.task_id)!);
      assert.equal(winner!.bidder, WORKER_B);
      assert.equal(winner!.price.amount, 300);
    });

    it("highest_reputation: selects most trusted agent", () => {
      // Give WORKER_C highest reputation, WORKER_A some failures to differentiate
      for (let i = 0; i < 20; i++) rep.recordTaskCompleted(WORKER_C, 100, 200);
      for (let i = 0; i < 5; i++) rep.recordTaskCompleted(WORKER_A, 100, 200);
      for (let i = 0; i < 3; i++) rep.recordTaskFailed(WORKER_A);

      const scoreC = rep.getScore(WORKER_C);
      const scoreA = rep.getScore(WORKER_A);
      assert.ok(scoreC > scoreA, `WORKER_C (${scoreC}) should have higher score than WORKER_A (${scoreA})`);

      const record = auction.createAuction(makeBroadcast({ selection: "highest_reputation" }));
      auction.submitBid(record.task_id, makeBid(WORKER_A, 300));
      auction.submitBid(record.task_id, makeBid(WORKER_C, 900));

      const winner = auction.selectWinner(auction.getAuction(record.task_id)!);
      assert.equal(winner!.bidder, WORKER_C);
    });

    it("best_value: balances price, reputation, and speed", () => {
      // WORKER_A: cheap but low reputation
      // WORKER_B: expensive but high reputation and fast
      for (let i = 0; i < 15; i++) rep.recordTaskCompleted(WORKER_B, 100, 200);

      const record = auction.createAuction(makeBroadcast({ selection: "best_value" }));
      auction.submitBid(record.task_id, makeBid(WORKER_A, 200, { estimated_duration_ms: 60000 }));
      auction.submitBid(record.task_id, makeBid(WORKER_B, 800, { estimated_duration_ms: 10000 }));

      const winner = auction.selectWinner(auction.getAuction(record.task_id)!);
      // WORKER_B should win: higher reputation (0.4 weight) + faster (0.2 weight) > price advantage
      assert.equal(winner!.bidder, WORKER_B);
    });

    it("manual: returns null (issuer must pick)", () => {
      const record = auction.createAuction(makeBroadcast({ selection: "manual" }));
      auction.submitBid(record.task_id, makeBid(WORKER_A, 500));
      const winner = auction.selectWinner(auction.getAuction(record.task_id)!);
      assert.equal(winner, null);
    });

    it("returns null when no bids", () => {
      const record = auction.createAuction(makeBroadcast());
      const winner = auction.selectWinner(auction.getAuction(record.task_id)!);
      assert.equal(winner, null);
    });
  });

  // ============================================================
  // Awarding
  // ============================================================

  describe("Awarding", () => {
    it("awards task to specific bidder", () => {
      const record = auction.createAuction(makeBroadcast());
      const { bid } = auction.submitBid(record.task_id, makeBid(WORKER_A, 500));
      const awarded = auction.awardTask(record.task_id, bid!.bid_id);
      assert.equal(awarded!.status, "awarded");
      assert.equal(awarded!.winner_agent_id, WORKER_A);
    });

    it("auto-awards on close with non-manual strategy", () => {
      const record = auction.createAuction(makeBroadcast({ selection: "lowest_price" }));
      auction.submitBid(record.task_id, makeBid(WORKER_A, 500));
      auction.submitBid(record.task_id, makeBid(WORKER_B, 300));
      const closed = auction.closeBidding(record.task_id);
      assert.equal(closed!.status, "awarded");
      assert.equal(closed!.winner_agent_id, WORKER_B);
    });

    it("emits auction:awarded event", () => {
      let emitted: any = null;
      auction.on("auction:awarded", (e) => { emitted = e; });
      const record = auction.createAuction(makeBroadcast());
      const { bid } = auction.submitBid(record.task_id, makeBid(WORKER_A, 500));
      auction.awardTask(record.task_id, bid!.bid_id);
      assert.ok(emitted);
      assert.equal(emitted.award.awarded_to, WORKER_A);
    });
  });

  // ============================================================
  // Full Lifecycle (Integration)
  // ============================================================

  describe("Full Lifecycle — reputation + verification + economic", () => {
    it("happy path: broadcast → bid → award → escrow → proof → pay → reputation up", () => {
      // 1. Broadcast
      const record = auction.createAuction(makeBroadcast({ selection: "lowest_price" }));

      // 2. Bid
      auction.submitBid(record.task_id, makeBid(WORKER_A, 500));

      // 3. Award
      auction.closeBidding(record.task_id);
      const awarded = auction.getAuction(record.task_id)!;
      assert.equal(awarded.status, "awarded");
      assert.equal(awarded.winner_agent_id, WORKER_A);

      // 4. Prepare execution (escrow + challenge)
      const prep = auction.prepareExecution(record.task_id, issuerKeys.privateKey, "key1");
      assert.ok(prep.success, `prep failed: ${prep.error}`);
      assert.ok(prep.escrow_id);
      assert.ok(prep.challenge);

      // Verify escrow locked
      const escrow = eco.getEscrow(prep.escrow_id!);
      assert.equal(escrow!.status, "locked");
      assert.equal(eco.getBalance(ISSUER, tokenId), 100000 - 500);

      // 5. Worker creates proof
      const taskInput = { pr_url: "https://github.com/org/repo/pull/42" };
      const taskOutput = { review: "LGTM", approved: true };
      const challenge = verifier.getChallenge(record.task_id);
      // Challenge was already consumed by prepareExecution, create new one for test
      const freshChallenge = verifier.createChallenge(record.task_id);
      const proof = verifier.createProof(
        record.task_id, taskInput, taskOutput,
        workerAKeys.privateKey, "workerKey1", freshChallenge
      );

      // 6. Finalize (verify + pay + reputation)
      const repBefore = rep.getScore(WORKER_A);
      const result = auction.finalizeExecution(
        record.task_id, proof, taskInput, taskOutput,
        workerAKeys.publicKey, issuerKeys.privateKey, "key1"
      );

      assert.ok(result.success);
      assert.ok(result.verified);
      assert.ok(result.paid);

      // 7. Check outcomes
      // Worker got paid
      assert.equal(eco.getBalance(WORKER_A, tokenId), 500);
      // Reputation increased
      assert.ok(rep.getScore(WORKER_A) > repBefore, "reputation should increase");
      // Auction completed
      assert.equal(auction.getAuction(record.task_id)!.status, "completed");
    });

    it("sad path: fake proof → refund → reputation down", () => {
      const record = auction.createAuction(makeBroadcast({ selection: "lowest_price" }));
      auction.submitBid(record.task_id, makeBid(WORKER_A, 500));
      auction.closeBidding(record.task_id);

      // Prepare
      const prep = auction.prepareExecution(record.task_id, issuerKeys.privateKey, "key1");
      assert.ok(prep.success);

      // Worker sends fake proof (wrong keys)
      const fakeKeys = generateKeyPair();
      const taskInput = { pr_url: "https://github.com/org/repo/pull/42" };
      const fakeOutput = { review: "looks good", approved: true };
      const fakeProof = verifier.createProof(
        record.task_id, taskInput, fakeOutput,
        fakeKeys.privateKey, "fakeKey"
      );

      // Finalize with real worker public key (proof was signed with fake key → mismatch)
      const repBefore = rep.getScore(WORKER_A);
      const result = auction.finalizeExecution(
        record.task_id, fakeProof, taskInput, fakeOutput,
        workerAKeys.publicKey, // expects real key, but proof was signed with fake
        issuerKeys.privateKey, "key1"
      );

      assert.ok(result.success); // process succeeded
      assert.ok(!result.verified); // but verification failed
      assert.ok(!result.paid); // no payment

      // Funds refunded to issuer
      assert.equal(eco.getBalance(ISSUER, tokenId), 100000); // fully restored
      assert.equal(eco.getBalance(WORKER_A, tokenId), 0); // nothing paid

      // Reputation decreased
      assert.ok(rep.getScore(WORKER_A) < repBefore, "reputation should decrease after failed verification");
    });

    it("cancellation refunds aren't possible before escrow", () => {
      const record = auction.createAuction(makeBroadcast());
      auction.submitBid(record.task_id, makeBid(WORKER_A, 500));
      const cancelled = auction.cancelAuction(record.task_id);
      assert.equal(cancelled!.status, "cancelled");
    });
  });

  // ============================================================
  // Deadline & Auto-close
  // ============================================================

  describe("Deadline", () => {
    it("auto-closes and selects winner after deadline", async () => {
      // Set deadline to 100ms from now
      const record = auction.createAuction(makeBroadcast({
        bid_deadline: new Date(Date.now() + 100).toISOString(),
        selection: "lowest_price",
      }));
      auction.submitBid(record.task_id, makeBid(WORKER_A, 500));

      // Wait for deadline
      await new Promise(r => setTimeout(r, 200));

      const updated = auction.getAuction(record.task_id)!;
      assert.equal(updated.status, "awarded");
      assert.equal(updated.winner_agent_id, WORKER_A);
    });

    it("marks no_bids when deadline passes with no bids", async () => {
      const record = auction.createAuction(makeBroadcast({
        bid_deadline: new Date(Date.now() + 100).toISOString(),
      }));

      await new Promise(r => setTimeout(r, 200));

      assert.equal(auction.getAuction(record.task_id)!.status, "no_bids");
    });

    it("rejects bids after deadline", async () => {
      const record = auction.createAuction(makeBroadcast({
        bid_deadline: new Date(Date.now() + 50).toISOString(),
      }));

      await new Promise(r => setTimeout(r, 100));

      const result = auction.submitBid(record.task_id, makeBid(WORKER_A, 500));
      assert.ok(!result.success);
    });
  });

  // ============================================================
  // Query
  // ============================================================

  describe("Query", () => {
    it("lists auctions by status", () => {
      auction.createAuction(makeBroadcast());
      auction.createAuction(makeBroadcast());
      const r3 = auction.createAuction(makeBroadcast());
      auction.cancelAuction(r3.task_id);

      assert.equal(auction.listAuctions("open").length, 2);
      assert.equal(auction.listAuctions("cancelled").length, 1);
      assert.equal(auction.getOpenAuctions().length, 2);
    });
  });
});
