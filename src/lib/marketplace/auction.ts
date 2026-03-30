/**
 * Marketplace Auction Manager — decentralized work market.
 *
 * Integrates all three security layers:
 *   [reputation] → filters bidders, ranks bids
 *   [execution]  → verifies task output
 *   [economic]   → escrow + payment
 *
 * Flow:
 *   1. Issuer broadcasts task to all peers (with budget, requirements)
 *   2. Agents submit bids (price, estimated time, capabilities)
 *   3. Bid deadline passes → auto-select winner based on strategy
 *   4. Winner is awarded → escrow locks funds
 *   5. Winner executes task → creates execution proof
 *   6. Issuer verifies proof → escrow releases payment
 *   7. Reputation updated for both parties
 */

import { EventEmitter } from "events";
import { randomBytes } from "crypto";
import type {
  AgentId,
  TaskBroadcast,
  TaskBid,
  TaskAward,
  AuctionStatus,
  AuctionRecord,
  BidSelectionStrategy,
} from "../../types/protocol";
import type { ReputationManager } from "../reputation/manager";
import type { EconomicManager } from "../economic/wallet";
import type { ExecutionVerifier } from "../verification/prover";
import type { ProfileManager } from "../matching/profile";

export interface AuctionManagerConfig {
  agentId: AgentId;
  reputation: ReputationManager;
  economic: EconomicManager;
  verifier: ExecutionVerifier;
  /** Optional: enables skill-based matching in best_value strategy */
  profileManager?: ProfileManager;
}

export class AuctionManager extends EventEmitter {
  private auctions = new Map<string, AuctionRecord>();
  private deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private config: AuctionManagerConfig;

  constructor(config: AuctionManagerConfig) {
    super();
    this.config = config;
  }

  // ============================================================
  // Issuer Side — Create & Manage Auctions
  // ============================================================

  /** Broadcast a task for bidding */
  createAuction(broadcast: Omit<TaskBroadcast, "task_id" | "created_at">): AuctionRecord {
    const taskId = `task_${randomBytes(16).toString("hex")}`;
    const now = new Date().toISOString();

    const fullBroadcast: TaskBroadcast = {
      ...broadcast,
      task_id: taskId,
      created_at: now,
    };

    return this.registerBroadcast(fullBroadcast);
  }

  /** Register a broadcast created elsewhere, preserving its original ID */
  registerBroadcast(broadcast: TaskBroadcast): AuctionRecord {
    const existing = this.auctions.get(broadcast.task_id);
    if (existing) return existing;

    const auction: AuctionRecord = {
      task_id: broadcast.task_id,
      broadcast,
      bids: [],
      status: "open",
      created_at: broadcast.created_at,
    };

    this.auctions.set(broadcast.task_id, auction);
    this.scheduleDeadline(broadcast.task_id, broadcast.bid_deadline);

    this.emit("auction:created", auction);
    return auction;
  }

  /** Manually close bidding and select winner */
  closeBidding(taskId: string): AuctionRecord | null {
    const auction = this.auctions.get(taskId);
    if (!auction || auction.status !== "open") return null;

    // Clear deadline timer
    const timer = this.deadlineTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.deadlineTimers.delete(taskId);
    }

    if (auction.bids.length === 0) {
      auction.status = "no_bids";
      this.emit("auction:no_bids", { task_id: taskId });
      return auction;
    }

    auction.status = "closed";

    // Auto-select if not manual
    if (auction.broadcast.selection !== "manual") {
      const winner = this.selectWinner(auction);
      if (winner) {
        return this.awardTask(taskId, winner.bid_id);
      }
    }

    this.emit("auction:closed", { task_id: taskId, bid_count: auction.bids.length });
    return auction;
  }

  /** Award task to a specific bid (manual selection or auto) */
  awardTask(taskId: string, bidId: string): AuctionRecord | null {
    const auction = this.auctions.get(taskId);
    if (!auction) return null;
    if (auction.status !== "open" && auction.status !== "closed") return null;

    const bid = auction.bids.find(b => b.bid_id === bidId);
    if (!bid) return null;

    auction.status = "awarded";
    auction.winner_bid_id = bidId;
    auction.winner_agent_id = bid.bidder;
    auction.awarded_at = new Date().toISOString();

    // Clear deadline timer if still running
    const timer = this.deadlineTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.deadlineTimers.delete(taskId);
    }

    const award: TaskAward = {
      task_id: taskId,
      bid_id: bidId,
      awarded_to: bid.bidder,
      agreed_price: bid.price,
      awarded_at: auction.awarded_at,
    };

    this.emit("auction:awarded", { auction, award, bid });
    return auction;
  }

  /** Apply an externally-awarded auction update received over P2P */
  applyAward(award: TaskAward): AuctionRecord | null {
    const auction = this.auctions.get(award.task_id);
    if (!auction) return null;
    if (auction.status === "completed" || auction.status === "cancelled") return null;

    this.clearDeadlineTimer(award.task_id);

    auction.status = "awarded";
    auction.winner_bid_id = award.bid_id;
    auction.winner_agent_id = award.awarded_to;
    auction.awarded_at = award.awarded_at;

    const bid = auction.bids.find((entry) => entry.bid_id === award.bid_id)
      ?? auction.bids.find((entry) => entry.bidder === award.awarded_to);

    this.emit("auction:awarded", { auction, award, bid });
    return auction;
  }

  /** Mark auction as completed (after proof verification + payment) */
  completeAuction(taskId: string, proofId: string, escrowId: string): AuctionRecord | null {
    const auction = this.auctions.get(taskId);
    if (!auction || auction.status !== "awarded") return null;

    auction.status = "completed";
    auction.proof_id = proofId;
    auction.escrow_id = escrowId;
    auction.completed_at = new Date().toISOString();

    this.emit("auction:completed", { task_id: taskId, winner: auction.winner_agent_id });
    return auction;
  }

  /** Cancel an auction */
  cancelAuction(taskId: string): AuctionRecord | null {
    const auction = this.auctions.get(taskId);
    if (!auction) return null;
    if (auction.status === "completed") return null;

    auction.status = "cancelled";

    const timer = this.deadlineTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.deadlineTimers.delete(taskId);
    }

    this.emit("auction:cancelled", { task_id: taskId });
    return auction;
  }

  // ============================================================
  // Bidder Side — Submit Bids
  // ============================================================

  /** Submit a bid on an open auction */
  submitBid(
    taskId: string,
    bid: Omit<TaskBid, "bid_id" | "submitted_at">
  ): { success: boolean; bid?: TaskBid; error?: string } {
    const auction = this.auctions.get(taskId);
    if (!auction) return { success: false, error: "Auction not found" };
    if (auction.status !== "open") return { success: false, error: `Auction is ${auction.status}, not accepting bids` };

    // Check bid deadline
    if (new Date(auction.broadcast.bid_deadline).getTime() < Date.now()) {
      return { success: false, error: "Bid deadline has passed" };
    }

    // Check minimum reputation
    if (auction.broadcast.min_reputation !== undefined) {
      const score = this.config.reputation.getScore(bid.bidder);
      if (score < auction.broadcast.min_reputation) {
        return {
          success: false,
          error: `Reputation ${score.toFixed(3)} below minimum ${auction.broadcast.min_reputation}`,
        };
      }
    }

    // Check required capabilities
    if (auction.broadcast.required_capabilities) {
      const missing = auction.broadcast.required_capabilities.filter(
        c => !bid.capabilities.includes(c)
      );
      if (missing.length > 0) {
        return { success: false, error: `Missing capabilities: ${missing.join(", ")}` };
      }
    }

    // Check budget
    if (bid.price.amount > auction.broadcast.budget.max_amount) {
      return { success: false, error: `Bid ${bid.price.amount} exceeds budget ${auction.broadcast.budget.max_amount}` };
    }

    // Check token match
    if (bid.price.token_id !== auction.broadcast.budget.token_id) {
      return { success: false, error: `Token mismatch: bid ${bid.price.token_id} vs auction ${auction.broadcast.budget.token_id}` };
    }

    // Prevent duplicate bids from same agent
    if (auction.bids.some(b => b.bidder === bid.bidder)) {
      return { success: false, error: "Already submitted a bid" };
    }

    const fullBid: TaskBid = {
      ...bid,
      bid_id: `bid_${randomBytes(16).toString("hex")}`,
      submitted_at: new Date().toISOString(),
    };

    auction.bids.push(fullBid);
    this.emit("auction:bid_received", { task_id: taskId, bid: fullBid });
    return { success: true, bid: fullBid };
  }

  // ============================================================
  // Bid Selection — Integrates Reputation
  // ============================================================

  /** Select the winning bid based on auction strategy */
  selectWinner(auction: AuctionRecord): TaskBid | null {
    if (auction.bids.length === 0) return null;

    const strategy = auction.broadcast.selection;
    const scoredBids = auction.bids.map(bid => ({
      bid,
      // Get actual reputation from our records (not self-reported)
      actualReputation: this.config.reputation.getScore(bid.bidder),
    }));

    switch (strategy) {
      case "lowest_price":
        scoredBids.sort((a, b) => a.bid.price.amount - b.bid.price.amount);
        return scoredBids[0].bid;

      case "highest_reputation":
        scoredBids.sort((a, b) => b.actualReputation - a.actualReputation);
        return scoredBids[0].bid;

      case "best_value": {
        // Weighted composite score — weights shift when skill matching is active:
        //   With skills:    30% price + 30% reputation + 15% speed + 25% skill match
        //   Without skills: 40% price + 40% reputation + 20% speed (legacy)
        const hasSkills = auction.broadcast.required_skills && auction.broadcast.required_skills.length > 0;
        const wPrice = hasSkills ? 0.3 : 0.4;
        const wRep = hasSkills ? 0.3 : 0.4;
        const wSpeed = hasSkills ? 0.15 : 0.2;
        const wSkill = hasSkills ? 0.25 : 0;

        const maxPrice = Math.max(...scoredBids.map(s => s.bid.price.amount));
        const maxDuration = Math.max(...scoredBids.map(s => s.bid.estimated_duration_ms || 1));

        const ranked = scoredBids.map(s => {
          const priceScore = 1 - (s.bid.price.amount / (maxPrice || 1));
          const repScore = s.actualReputation;
          const speedScore = 1 - ((s.bid.estimated_duration_ms || maxDuration) / (maxDuration || 1));

          let skillScore = 0;
          if (hasSkills && this.config.profileManager) {
            skillScore = this.config.profileManager.getMatchScore(
              s.bid.bidder,
              auction.broadcast.required_skills!
            );
          }

          const composite = priceScore * wPrice + repScore * wRep + speedScore * wSpeed + skillScore * wSkill;
          return { ...s, composite };
        });

        ranked.sort((a, b) => b.composite - a.composite);
        return ranked[0].bid;
      }

      case "manual":
        return null; // issuer must call awardTask manually

      default:
        return scoredBids[0].bid;
    }
  }

  // ============================================================
  // Full Lifecycle — Orchestrated flow
  // ============================================================

  /**
   * Execute the full marketplace flow after awarding:
   *   1. Create escrow (lock funds)
   *   2. Create challenge for verification
   *   3. Return everything needed for the worker to execute
   */
  prepareExecution(
    taskId: string,
    privateKey: Uint8Array,
    keyId: string
  ): {
    success: boolean;
    escrow_id?: string;
    offer_id?: string;
    challenge?: { nonce: string; expires_at: string };
    error?: string;
  } {
    const auction = this.auctions.get(taskId);
    if (!auction || auction.status !== "awarded") {
      return { success: false, error: "Auction not awarded" };
    }

    const winnerBid = auction.bids.find(b => b.bid_id === auction.winner_bid_id);
    if (!winnerBid) return { success: false, error: "Winner bid not found" };

    // 1. Create payment offer
    const offer = this.config.economic.createOffer(
      taskId,
      winnerBid.bidder,
      winnerBid.price.token_id,
      winnerBid.price.amount
    );

    // 2. Lock escrow
    const escrowResult = this.config.economic.lockEscrow(offer.offer_id, privateKey, keyId);
    if (!escrowResult.success) {
      return { success: false, error: `Escrow lock failed: ${escrowResult.error}` };
    }

    auction.escrow_id = escrowResult.escrow!.escrow_id;

    // 3. Create verification challenge
    const challenge = this.config.verifier.createChallenge(taskId);

    this.emit("auction:execution_prepared", {
      task_id: taskId,
      escrow_id: escrowResult.escrow!.escrow_id,
      challenge,
    });

    return {
      success: true,
      escrow_id: escrowResult.escrow!.escrow_id,
      offer_id: offer.offer_id,
      challenge: { nonce: challenge.nonce, expires_at: challenge.expires_at },
    };
  }

  /**
   * Finalize after receiving worker's proof:
   *   1. Verify execution proof
   *   2. Release escrow on success / refund on failure
   *   3. Update reputation
   */
  finalizeExecution(
    taskId: string,
    proof: any, // ExecutionProof
    expectedInput: Record<string, unknown>,
    receivedOutput: Record<string, unknown>,
    workerPublicKey: Uint8Array,
    privateKey: Uint8Array,
    keyId: string
  ): {
    success: boolean;
    verified: boolean;
    paid: boolean;
    error?: string;
  } {
    const auction = this.auctions.get(taskId);
    if (!auction || auction.status !== "awarded") {
      return { success: false, verified: false, paid: false, error: "Auction not awarded" };
    }

    // 1. Verify proof
    const verification = this.config.verifier.verifyProof(
      proof, expectedInput, receivedOutput, workerPublicKey
    );

    if (verification.valid) {
      // 2a. Release escrow
      const escrowId = auction.escrow_id!;
      const releaseResult = this.config.economic.releaseEscrow(
        escrowId, proof.proof_id, privateKey, keyId
      );

      if (!releaseResult.success) {
        return { success: false, verified: true, paid: false, error: `Release failed: ${releaseResult.error}` };
      }

      // 3a. Update reputation positively
      this.config.reputation.recordTaskCompleted(auction.winner_agent_id!, 0, 0);
      this.config.reputation.recordVerifiedProof(auction.winner_agent_id!);

      // 4. Mark auction complete
      this.completeAuction(taskId, proof.proof_id, escrowId);

      return { success: true, verified: true, paid: true };
    } else {
      // 2b. Refund escrow
      const escrowId = auction.escrow_id!;
      this.config.economic.refundEscrow(escrowId, privateKey, keyId);

      // 3b. Update reputation negatively
      this.config.reputation.recordTaskFailed(auction.winner_agent_id!);

      return {
        success: true,
        verified: false,
        paid: false,
        error: `Verification failed: ${verification.error}`,
      };
    }
  }

  // ============================================================
  // Query
  // ============================================================

  getAuction(taskId: string): AuctionRecord | null {
    return this.auctions.get(taskId) ?? null;
  }

  listAuctions(status?: AuctionStatus): AuctionRecord[] {
    const all = Array.from(this.auctions.values());
    return status ? all.filter(a => a.status === status) : all;
  }

  getOpenAuctions(): AuctionRecord[] {
    return this.listAuctions("open");
  }

  getBidsForTask(taskId: string): TaskBid[] {
    return this.auctions.get(taskId)?.bids ?? [];
  }

  // ============================================================
  // Cleanup
  // ============================================================

  destroy(): void {
    for (const timer of this.deadlineTimers.values()) {
      clearTimeout(timer);
    }
    this.deadlineTimers.clear();
    this.auctions.clear();
    this.removeAllListeners();
  }

  private scheduleDeadline(taskId: string, bidDeadline: string): void {
    this.clearDeadlineTimer(taskId);

    const deadlineMs = new Date(bidDeadline).getTime() - Date.now();
    if (deadlineMs <= 0) return;

    const timer = setTimeout(() => {
      this.closeBidding(taskId);
    }, deadlineMs);
    timer.unref?.();
    this.deadlineTimers.set(taskId, timer);
  }

  private clearDeadlineTimer(taskId: string): void {
    const timer = this.deadlineTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.deadlineTimers.delete(taskId);
  }
}
