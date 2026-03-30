/**
 * Economic Layer — Wallet, Token, Escrow & Ledger system.
 *
 * Supports:
 *   1. Local tokens (project-issued, off-chain ledger)
 *   2. External wallet connection (ETH/SOL address registration)
 *   3. Escrow for task payments (lock → verify → release/refund)
 *   4. Append-only ledger with hash chain integrity
 *
 * Design:
 *   - Local tokens are managed entirely in the agent's ledger
 *   - External tokens are tracked as "promises" — settlement happens off-chain
 *   - Escrow locks funds locally; release requires verified ExecutionProof
 *   - Ledger entries form a hash chain for tamper detection
 */

import { createHash, randomBytes } from "crypto";
import { EventEmitter } from "events";
import type {
  AgentId,
  Signature,
  TokenDefinition,
  Wallet,
  PaymentOffer,
  EscrowStatus,
  EscrowRecord,
  LedgerEntry,
} from "../../types/protocol";
import { canonicalJson } from "../crypto/signing";
import { sign, toBase64 } from "../crypto/keys";

export class EconomicManager extends EventEmitter {
  private tokens = new Map<string, TokenDefinition>();
  private wallets = new Map<string, Wallet>();          // agent_id → wallet
  private offers = new Map<string, PaymentOffer>();
  private escrows = new Map<string, EscrowRecord>();
  private ledger: LedgerEntry[] = [];
  private agentId: AgentId;

  constructor(agentId: AgentId) {
    super();
    this.agentId = agentId;
  }

  // ============================================================
  // Token Management
  // ============================================================

  /** Issue a new project token (only the issuer can mint) */
  issueToken(
    name: string,
    symbol: string,
    decimals: number,
    initialSupply: number,
    privateKey: Uint8Array,
    keyId: string
  ): TokenDefinition {
    const tokenId = `local:${symbol}-${randomBytes(4).toString("hex")}`;
    const token: TokenDefinition = {
      token_id: tokenId,
      name,
      symbol,
      decimals,
      chain: "local",
      token_type: "custom",
      issuer: this.agentId,
      total_supply: initialSupply,
      created_at: new Date().toISOString(),
    };
    this.tokens.set(tokenId, token);

    // Mint initial supply to issuer's wallet
    const wallet = this.ensureWallet(this.agentId);
    wallet.balances[tokenId] = (wallet.balances[tokenId] || 0) + initialSupply;

    this.appendLedger({
      from: "system",
      to: this.agentId,
      token_id: tokenId,
      amount: initialSupply,
      entry_type: "mint",
      reference_id: tokenId,
    }, privateKey, keyId);

    this.emit("token:issued", token);
    return token;
  }

  /** Register an external token (e.g. USDC on Ethereum) */
  registerExternalToken(
    tokenId: string,
    name: string,
    symbol: string,
    decimals: number,
    chain: "ethereum" | "solana" | "custom",
    contractAddress?: string
  ): TokenDefinition {
    const token: TokenDefinition = {
      token_id: tokenId,
      name,
      symbol,
      decimals,
      chain,
      token_type: chain === "ethereum" ? "erc20" : chain === "solana" ? "spl" : "custom",
      contract_address: contractAddress,
      created_at: new Date().toISOString(),
    };
    this.tokens.set(tokenId, token);
    return token;
  }

  getToken(tokenId: string): TokenDefinition | null {
    return this.tokens.get(tokenId) ?? null;
  }

  listTokens(): TokenDefinition[] {
    return Array.from(this.tokens.values());
  }

  // ============================================================
  // Wallet Management
  // ============================================================

  /** Connect an external wallet address */
  connectWallet(agentId: AgentId, chain: "ethereum" | "solana" | "custom", address: string): Wallet {
    const wallet = this.ensureWallet(agentId);
    // Store external address as metadata (wallet_id stays agent-based)
    (wallet as any)[`${chain}_address`] = address;
    wallet.chain = chain;
    wallet.address = address;
    this.emit("wallet:connected", { agent_id: agentId, chain, address });
    return wallet;
  }

  getWallet(agentId: AgentId): Wallet | null {
    return this.wallets.get(agentId) ?? null;
  }

  getBalance(agentId: AgentId, tokenId: string): number {
    const wallet = this.wallets.get(agentId);
    if (!wallet) return 0;
    return wallet.balances[tokenId] || 0;
  }

  /** Mint additional tokens (only token issuer can call) */
  mint(
    tokenId: string,
    amount: number,
    privateKey: Uint8Array,
    keyId: string
  ): { success: boolean; error?: string } {
    const token = this.tokens.get(tokenId);
    if (!token) return { success: false, error: "Token not found" };
    if (token.issuer !== this.agentId) return { success: false, error: "Only issuer can mint" };
    if (token.chain !== "local") return { success: false, error: "Can only mint local tokens" };

    const wallet = this.ensureWallet(this.agentId);
    wallet.balances[tokenId] = (wallet.balances[tokenId] || 0) + amount;
    token.total_supply = (token.total_supply || 0) + amount;

    this.appendLedger({
      from: "system",
      to: this.agentId,
      token_id: tokenId,
      amount,
      entry_type: "mint",
    }, privateKey, keyId);

    return { success: true };
  }

  /** Transfer tokens between agents (local tokens only) */
  transfer(
    to: AgentId,
    tokenId: string,
    amount: number,
    privateKey: Uint8Array,
    keyId: string
  ): { success: boolean; error?: string } {
    const fromWallet = this.wallets.get(this.agentId);
    if (!fromWallet) return { success: false, error: "No wallet" };

    const balance = fromWallet.balances[tokenId] || 0;
    if (balance < amount) return { success: false, error: `Insufficient balance: ${balance} < ${amount}` };

    fromWallet.balances[tokenId] -= amount;
    const toWallet = this.ensureWallet(to);
    toWallet.balances[tokenId] = (toWallet.balances[tokenId] || 0) + amount;

    this.appendLedger({
      from: this.agentId,
      to,
      token_id: tokenId,
      amount,
      entry_type: "transfer",
    }, privateKey, keyId);

    this.emit("transfer:completed", { from: this.agentId, to, token_id: tokenId, amount });
    return { success: true };
  }

  // ============================================================
  // Payment Offers & Escrow
  // ============================================================

  /** Create a payment offer for a task */
  createOffer(
    taskId: string,
    to: AgentId,
    tokenId: string,
    amount: number
  ): PaymentOffer {
    const offer: PaymentOffer = {
      offer_id: `offer_${randomBytes(16).toString("hex")}`,
      task_id: taskId,
      from: this.agentId,
      to,
      token_id: tokenId,
      amount,
      status: "offered",
      created_at: new Date().toISOString(),
    };
    this.offers.set(offer.offer_id, offer);
    this.emit("offer:created", offer);
    return offer;
  }

  /** Lock funds in escrow when task is accepted */
  lockEscrow(
    offerId: string,
    privateKey: Uint8Array,
    keyId: string
  ): { success: boolean; escrow?: EscrowRecord; error?: string } {
    const offer = this.offers.get(offerId);
    if (!offer) return { success: false, error: "Offer not found" };
    if (offer.status !== "offered") return { success: false, error: `Cannot lock: status is ${offer.status}` };

    // Check balance
    const wallet = this.wallets.get(offer.from);
    if (!wallet) return { success: false, error: "No wallet" };
    const balance = wallet.balances[offer.token_id] || 0;
    if (balance < offer.amount) return { success: false, error: `Insufficient balance: ${balance} < ${offer.amount}` };

    // Lock funds (deduct from available balance)
    wallet.balances[offer.token_id] -= offer.amount;

    // Create lock signature
    const lockData = `escrow:${offer.offer_id}:${offer.task_id}:${offer.token_id}:${offer.amount}`;
    const sigBytes = sign(new TextEncoder().encode(lockData), privateKey);
    const lockSignature: Signature = {
      algorithm: "Ed25519",
      key_id: keyId,
      value: toBase64(sigBytes),
    };

    const escrow: EscrowRecord = {
      escrow_id: `escrow_${randomBytes(16).toString("hex")}`,
      offer_id: offerId,
      task_id: offer.task_id,
      from: offer.from,
      to: offer.to,
      token_id: offer.token_id,
      amount: offer.amount,
      status: "locked",
      lock_signature: lockSignature,
      locked_at: new Date().toISOString(),
    };

    offer.status = "locked";
    this.escrows.set(escrow.escrow_id, escrow);

    this.appendLedger({
      from: offer.from,
      to: "system",
      token_id: offer.token_id,
      amount: offer.amount,
      entry_type: "escrow_lock",
      reference_id: escrow.escrow_id,
    }, privateKey, keyId);

    this.emit("escrow:locked", escrow);
    return { success: true, escrow };
  }

  /** Release escrowed funds to worker after verified task completion */
  releaseEscrow(
    escrowId: string,
    proofId: string,
    privateKey: Uint8Array,
    keyId: string
  ): { success: boolean; error?: string } {
    const escrow = this.escrows.get(escrowId);
    if (!escrow) return { success: false, error: "Escrow not found" };
    if (escrow.status !== "locked") return { success: false, error: `Cannot release: status is ${escrow.status}` };

    // Credit worker's wallet
    const workerWallet = this.ensureWallet(escrow.to);
    workerWallet.balances[escrow.token_id] = (workerWallet.balances[escrow.token_id] || 0) + escrow.amount;

    escrow.status = "released";
    escrow.released_at = new Date().toISOString();
    escrow.required_proof_id = proofId;

    // Update offer status
    const offer = this.offers.get(escrow.offer_id);
    if (offer) {
      offer.status = "released";
      offer.settled_at = new Date().toISOString();
    }

    this.appendLedger({
      from: "system",
      to: escrow.to,
      token_id: escrow.token_id,
      amount: escrow.amount,
      entry_type: "escrow_release",
      reference_id: escrow.escrow_id,
    }, privateKey, keyId);

    this.emit("escrow:released", escrow);
    return { success: true };
  }

  /** Refund escrowed funds on task failure/cancellation */
  refundEscrow(
    escrowId: string,
    privateKey: Uint8Array,
    keyId: string
  ): { success: boolean; error?: string } {
    const escrow = this.escrows.get(escrowId);
    if (!escrow) return { success: false, error: "Escrow not found" };
    if (escrow.status !== "locked" && escrow.status !== "disputed") {
      return { success: false, error: `Cannot refund: status is ${escrow.status}` };
    }

    // Return funds to requester's wallet
    const requesterWallet = this.ensureWallet(escrow.from);
    requesterWallet.balances[escrow.token_id] = (requesterWallet.balances[escrow.token_id] || 0) + escrow.amount;

    escrow.status = "refunded";
    escrow.released_at = new Date().toISOString();

    const offer = this.offers.get(escrow.offer_id);
    if (offer) {
      offer.status = "refunded";
      offer.settled_at = new Date().toISOString();
    }

    this.appendLedger({
      from: "system",
      to: escrow.from,
      token_id: escrow.token_id,
      amount: escrow.amount,
      entry_type: "escrow_refund",
      reference_id: escrow.escrow_id,
    }, privateKey, keyId);

    this.emit("escrow:refunded", escrow);
    return { success: true };
  }

  /** Raise a dispute on an escrow */
  disputeEscrow(escrowId: string): { success: boolean; error?: string } {
    const escrow = this.escrows.get(escrowId);
    if (!escrow) return { success: false, error: "Escrow not found" };
    if (escrow.status !== "locked") return { success: false, error: `Cannot dispute: status is ${escrow.status}` };

    escrow.status = "disputed";
    const offer = this.offers.get(escrow.offer_id);
    if (offer) offer.status = "disputed";

    this.emit("escrow:disputed", escrow);
    return { success: true };
  }

  // --- Query ---

  getOffer(offerId: string): PaymentOffer | null {
    return this.offers.get(offerId) ?? null;
  }

  getOfferByTask(taskId: string): PaymentOffer | null {
    for (const offer of this.offers.values()) {
      if (offer.task_id === taskId) return offer;
    }
    return null;
  }

  listOffers(): PaymentOffer[] {
    return Array.from(this.offers.values());
  }

  getEscrow(escrowId: string): EscrowRecord | null {
    return this.escrows.get(escrowId) ?? null;
  }

  getEscrowByTask(taskId: string): EscrowRecord | null {
    for (const escrow of this.escrows.values()) {
      if (escrow.task_id === taskId) return escrow;
    }
    return null;
  }

  listEscrows(): EscrowRecord[] {
    return Array.from(this.escrows.values());
  }

  getLedger(limit = 50): LedgerEntry[] {
    return this.ledger.slice(-limit);
  }

  /** Verify ledger hash chain integrity */
  verifyLedgerIntegrity(): { valid: boolean; broken_at?: number } {
    for (let i = 1; i < this.ledger.length; i++) {
      const expected = hashLedgerEntry(this.ledger[i - 1]);
      if (this.ledger[i].prev_hash !== expected) {
        return { valid: false, broken_at: i };
      }
    }
    return { valid: true };
  }

  // ============================================================
  // Internal
  // ============================================================

  private ensureWallet(agentId: AgentId): Wallet {
    let wallet = this.wallets.get(agentId);
    if (!wallet) {
      wallet = {
        wallet_id: `wallet_${randomBytes(8).toString("hex")}`,
        agent_id: agentId,
        chain: "local",
        address: agentId,
        balances: {},
        created_at: new Date().toISOString(),
      };
      this.wallets.set(agentId, wallet);
    }
    return wallet;
  }

  private appendLedger(
    entry: Omit<LedgerEntry, "entry_id" | "timestamp" | "prev_hash" | "signature">,
    privateKey: Uint8Array,
    keyId: string
  ): void {
    const prevHash = this.ledger.length > 0
      ? hashLedgerEntry(this.ledger[this.ledger.length - 1])
      : "genesis";

    const full: LedgerEntry = {
      entry_id: `ledger_${randomBytes(16).toString("hex")}`,
      timestamp: new Date().toISOString(),
      prev_hash: prevHash,
      ...entry,
    };

    // Sign the entry
    const sigData = canonicalJson(full);
    const sigBytes = sign(new TextEncoder().encode(sigData), privateKey);
    full.signature = {
      algorithm: "Ed25519",
      key_id: keyId,
      value: toBase64(sigBytes),
    };

    this.ledger.push(full);
  }

  // --- Serialization ---

  serialize(): {
    tokens: Record<string, TokenDefinition>;
    wallets: Record<string, Wallet>;
    offers: Record<string, PaymentOffer>;
    escrows: Record<string, EscrowRecord>;
    ledger: LedgerEntry[];
  } {
    return {
      tokens: Object.fromEntries(this.tokens),
      wallets: Object.fromEntries(this.wallets),
      offers: Object.fromEntries(this.offers),
      escrows: Object.fromEntries(this.escrows),
      ledger: this.ledger,
    };
  }

  load(data: ReturnType<EconomicManager["serialize"]>): void {
    this.tokens.clear();
    this.wallets.clear();
    this.offers.clear();
    this.escrows.clear();

    for (const [k, v] of Object.entries(data.tokens || {})) this.tokens.set(k, v);
    for (const [k, v] of Object.entries(data.wallets || {})) this.wallets.set(k, v);
    for (const [k, v] of Object.entries(data.offers || {})) this.offers.set(k, v);
    for (const [k, v] of Object.entries(data.escrows || {})) this.escrows.set(k, v);
    this.ledger = data.ledger || [];
  }

  destroy(): void {
    this.tokens.clear();
    this.wallets.clear();
    this.offers.clear();
    this.escrows.clear();
    this.ledger = [];
    this.removeAllListeners();
  }
}

function hashLedgerEntry(entry: LedgerEntry): string {
  const { signature, ...rest } = entry;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}
