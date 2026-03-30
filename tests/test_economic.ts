import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EconomicManager } from "../src/lib/economic/wallet";
import { generateKeyPair } from "../src/lib/crypto/keys";
import type { AgentId } from "../src/types/protocol";

const AGENT_A = "agent:org1:alice" as AgentId;
const AGENT_B = "agent:org2:bob" as AgentId;

describe("EconomicManager", () => {
  let eco: EconomicManager;
  let keys: { privateKey: Uint8Array; publicKey: Uint8Array };
  const keyId = "test-key-1";

  beforeEach(() => {
    eco = new EconomicManager(AGENT_A);
    keys = generateKeyPair();
  });

  // ============================================================
  // Token Issuance
  // ============================================================

  describe("Token Issuance", () => {
    it("issues a local custom token", () => {
      const token = eco.issueToken("ProjectCoin", "PROJ", 18, 1000000, keys.privateKey, keyId);
      assert.ok(token.token_id.startsWith("local:PROJ-"));
      assert.equal(token.name, "ProjectCoin");
      assert.equal(token.symbol, "PROJ");
      assert.equal(token.chain, "local");
      assert.equal(token.token_type, "custom");
      assert.equal(token.issuer, AGENT_A);
      assert.equal(token.total_supply, 1000000);
    });

    it("mints initial supply to issuer wallet", () => {
      const token = eco.issueToken("Coin", "COIN", 18, 5000, keys.privateKey, keyId);
      assert.equal(eco.getBalance(AGENT_A, token.token_id), 5000);
    });

    it("registers external token", () => {
      const token = eco.registerExternalToken(
        "eth:USDC", "USD Coin", "USDC", 6, "ethereum", "0x1234..."
      );
      assert.equal(token.token_id, "eth:USDC");
      assert.equal(token.chain, "ethereum");
      assert.equal(token.token_type, "erc20");
    });

    it("mints additional tokens", () => {
      const token = eco.issueToken("Coin", "COIN", 18, 1000, keys.privateKey, keyId);
      const result = eco.mint(token.token_id, 500, keys.privateKey, keyId);
      assert.ok(result.success);
      assert.equal(eco.getBalance(AGENT_A, token.token_id), 1500);
      assert.equal(eco.getToken(token.token_id)!.total_supply, 1500);
    });

    it("rejects mint from non-issuer", () => {
      const token = eco.issueToken("Coin", "COIN", 18, 1000, keys.privateKey, keyId);
      // Create a second manager as AGENT_B
      const eco2 = new EconomicManager(AGENT_B);
      // Load token data into eco2 (simulating shared state)
      const data = eco.serialize();
      eco2.load(data);
      const result = eco2.mint(token.token_id, 500, keys.privateKey, keyId);
      assert.ok(!result.success);
      assert.ok(result.error!.includes("issuer"));
    });

    it("lists tokens", () => {
      eco.issueToken("A", "AAA", 18, 100, keys.privateKey, keyId);
      eco.issueToken("B", "BBB", 18, 200, keys.privateKey, keyId);
      assert.equal(eco.listTokens().length, 2);
    });
  });

  // ============================================================
  // Wallet & Transfer
  // ============================================================

  describe("Wallet & Transfer", () => {
    it("auto-creates wallet on first interaction", () => {
      eco.issueToken("Coin", "C", 18, 100, keys.privateKey, keyId);
      const wallet = eco.getWallet(AGENT_A);
      assert.ok(wallet);
      assert.equal(wallet.agent_id, AGENT_A);
    });

    it("connects external wallet address", () => {
      const wallet = eco.connectWallet(AGENT_A, "ethereum", "0xAbCdEf...");
      assert.equal(wallet.chain, "ethereum");
      assert.equal(wallet.address, "0xAbCdEf...");
    });

    it("transfers tokens between agents", () => {
      const token = eco.issueToken("Coin", "C", 18, 1000, keys.privateKey, keyId);
      const result = eco.transfer(AGENT_B, token.token_id, 300, keys.privateKey, keyId);
      assert.ok(result.success);
      assert.equal(eco.getBalance(AGENT_A, token.token_id), 700);
      assert.equal(eco.getBalance(AGENT_B, token.token_id), 300);
    });

    it("rejects transfer with insufficient balance", () => {
      const token = eco.issueToken("Coin", "C", 18, 100, keys.privateKey, keyId);
      const result = eco.transfer(AGENT_B, token.token_id, 200, keys.privateKey, keyId);
      assert.ok(!result.success);
      assert.ok(result.error!.includes("Insufficient"));
    });

    it("rejects transfer from agent with no wallet", () => {
      const eco2 = new EconomicManager(AGENT_B);
      const result = eco2.transfer(AGENT_A, "fake:token", 100, keys.privateKey, keyId);
      assert.ok(!result.success);
    });

    it("balance is 0 for unknown token", () => {
      assert.equal(eco.getBalance(AGENT_A, "nonexistent:token"), 0);
    });
  });

  // ============================================================
  // Payment Offers & Escrow
  // ============================================================

  describe("Escrow", () => {
    let tokenId: string;

    beforeEach(() => {
      const token = eco.issueToken("Coin", "C", 18, 10000, keys.privateKey, keyId);
      tokenId = token.token_id;
    });

    it("creates a payment offer", () => {
      const offer = eco.createOffer("task_1", AGENT_B, tokenId, 500);
      assert.ok(offer.offer_id.startsWith("offer_"));
      assert.equal(offer.status, "offered");
      assert.equal(offer.amount, 500);
    });

    it("locks escrow on task accept", () => {
      const offer = eco.createOffer("task_1", AGENT_B, tokenId, 500);
      const result = eco.lockEscrow(offer.offer_id, keys.privateKey, keyId);
      assert.ok(result.success);
      assert.ok(result.escrow);
      assert.equal(result.escrow.status, "locked");
      // Balance should decrease by locked amount
      assert.equal(eco.getBalance(AGENT_A, tokenId), 9500);
    });

    it("releases escrow to worker on completion", () => {
      const offer = eco.createOffer("task_1", AGENT_B, tokenId, 500);
      eco.lockEscrow(offer.offer_id, keys.privateKey, keyId);
      const escrow = eco.getEscrowByTask("task_1")!;

      const result = eco.releaseEscrow(escrow.escrow_id, "proof_123", keys.privateKey, keyId);
      assert.ok(result.success);
      assert.equal(eco.getBalance(AGENT_B, tokenId), 500);
      assert.equal(eco.getEscrow(escrow.escrow_id)!.status, "released");
    });

    it("refunds escrow on failure", () => {
      const offer = eco.createOffer("task_1", AGENT_B, tokenId, 500);
      eco.lockEscrow(offer.offer_id, keys.privateKey, keyId);
      const escrow = eco.getEscrowByTask("task_1")!;

      const result = eco.refundEscrow(escrow.escrow_id, keys.privateKey, keyId);
      assert.ok(result.success);
      assert.equal(eco.getBalance(AGENT_A, tokenId), 10000); // fully restored
      assert.equal(eco.getBalance(AGENT_B, tokenId), 0);
    });

    it("rejects double lock", () => {
      const offer = eco.createOffer("task_1", AGENT_B, tokenId, 500);
      eco.lockEscrow(offer.offer_id, keys.privateKey, keyId);
      const result = eco.lockEscrow(offer.offer_id, keys.privateKey, keyId);
      assert.ok(!result.success);
      assert.ok(result.error!.includes("Cannot lock"));
    });

    it("rejects lock with insufficient balance", () => {
      const offer = eco.createOffer("task_1", AGENT_B, tokenId, 99999);
      const result = eco.lockEscrow(offer.offer_id, keys.privateKey, keyId);
      assert.ok(!result.success);
      assert.ok(result.error!.includes("Insufficient"));
    });

    it("rejects release on non-locked escrow", () => {
      const offer = eco.createOffer("task_1", AGENT_B, tokenId, 500);
      eco.lockEscrow(offer.offer_id, keys.privateKey, keyId);
      const escrow = eco.getEscrowByTask("task_1")!;
      eco.releaseEscrow(escrow.escrow_id, "proof_1", keys.privateKey, keyId);

      // Try releasing again
      const result = eco.releaseEscrow(escrow.escrow_id, "proof_2", keys.privateKey, keyId);
      assert.ok(!result.success);
    });

    it("disputes an escrow", () => {
      const offer = eco.createOffer("task_1", AGENT_B, tokenId, 500);
      eco.lockEscrow(offer.offer_id, keys.privateKey, keyId);
      const escrow = eco.getEscrowByTask("task_1")!;

      const result = eco.disputeEscrow(escrow.escrow_id);
      assert.ok(result.success);
      assert.equal(eco.getEscrow(escrow.escrow_id)!.status, "disputed");
    });

    it("can refund disputed escrow", () => {
      const offer = eco.createOffer("task_1", AGENT_B, tokenId, 500);
      eco.lockEscrow(offer.offer_id, keys.privateKey, keyId);
      const escrow = eco.getEscrowByTask("task_1")!;
      eco.disputeEscrow(escrow.escrow_id);

      const result = eco.refundEscrow(escrow.escrow_id, keys.privateKey, keyId);
      assert.ok(result.success);
      assert.equal(eco.getBalance(AGENT_A, tokenId), 10000);
    });

    it("queries offers and escrows", () => {
      eco.createOffer("task_1", AGENT_B, tokenId, 500);
      eco.createOffer("task_2", AGENT_B, tokenId, 300);
      assert.equal(eco.listOffers().length, 2);
      assert.ok(eco.getOfferByTask("task_1"));
    });
  });

  // ============================================================
  // Ledger
  // ============================================================

  describe("Ledger", () => {
    it("records all transactions in order", () => {
      const token = eco.issueToken("Coin", "C", 18, 1000, keys.privateKey, keyId);
      eco.transfer(AGENT_B, token.token_id, 200, keys.privateKey, keyId);

      const entries = eco.getLedger();
      assert.ok(entries.length >= 2);
      assert.equal(entries[0].entry_type, "mint");
      assert.equal(entries[1].entry_type, "transfer");
    });

    it("maintains hash chain integrity", () => {
      const token = eco.issueToken("Coin", "C", 18, 1000, keys.privateKey, keyId);
      eco.transfer(AGENT_B, token.token_id, 100, keys.privateKey, keyId);
      eco.transfer(AGENT_B, token.token_id, 200, keys.privateKey, keyId);

      const integrity = eco.verifyLedgerIntegrity();
      assert.ok(integrity.valid, "ledger should have valid hash chain");
    });

    it("first entry has genesis prev_hash", () => {
      eco.issueToken("Coin", "C", 18, 1000, keys.privateKey, keyId);
      const entries = eco.getLedger();
      assert.equal(entries[0].prev_hash, "genesis");
    });

    it("entries are signed", () => {
      eco.issueToken("Coin", "C", 18, 1000, keys.privateKey, keyId);
      const entries = eco.getLedger();
      assert.ok(entries[0].signature);
      assert.equal(entries[0].signature!.algorithm, "Ed25519");
    });

    it("escrow operations create ledger entries", () => {
      const token = eco.issueToken("Coin", "C", 18, 1000, keys.privateKey, keyId);
      const offer = eco.createOffer("task_1", AGENT_B, token.token_id, 300);
      eco.lockEscrow(offer.offer_id, keys.privateKey, keyId);
      const escrow = eco.getEscrowByTask("task_1")!;
      eco.releaseEscrow(escrow.escrow_id, "proof_1", keys.privateKey, keyId);

      const entries = eco.getLedger();
      const types = entries.map(e => e.entry_type);
      assert.ok(types.includes("mint"));
      assert.ok(types.includes("escrow_lock"));
      assert.ok(types.includes("escrow_release"));

      // Hash chain still valid after escrow ops
      assert.ok(eco.verifyLedgerIntegrity().valid);
    });
  });

  // ============================================================
  // Serialization
  // ============================================================

  describe("Serialization", () => {
    it("round-trips all state", () => {
      const token = eco.issueToken("Coin", "C", 18, 1000, keys.privateKey, keyId);
      eco.transfer(AGENT_B, token.token_id, 200, keys.privateKey, keyId);
      eco.createOffer("task_1", AGENT_B, token.token_id, 100);

      const data = eco.serialize();
      const eco2 = new EconomicManager(AGENT_A);
      eco2.load(data);

      assert.equal(eco2.getBalance(AGENT_A, token.token_id), 800);
      assert.equal(eco2.getBalance(AGENT_B, token.token_id), 200);
      assert.equal(eco2.listTokens().length, 1);
      assert.equal(eco2.listOffers().length, 1);
      assert.ok(eco2.verifyLedgerIntegrity().valid);
    });
  });

  // ============================================================
  // Events
  // ============================================================

  describe("Events", () => {
    it("emits token:issued", () => {
      let emitted = false;
      eco.on("token:issued", () => { emitted = true; });
      eco.issueToken("Coin", "C", 18, 100, keys.privateKey, keyId);
      assert.ok(emitted);
    });

    it("emits transfer:completed", () => {
      let emitted: any = null;
      eco.on("transfer:completed", (e) => { emitted = e; });
      const token = eco.issueToken("Coin", "C", 18, 1000, keys.privateKey, keyId);
      eco.transfer(AGENT_B, token.token_id, 100, keys.privateKey, keyId);
      assert.ok(emitted);
      assert.equal(emitted.amount, 100);
    });

    it("emits escrow lifecycle events", () => {
      const events: string[] = [];
      eco.on("escrow:locked", () => events.push("locked"));
      eco.on("escrow:released", () => events.push("released"));

      const token = eco.issueToken("Coin", "C", 18, 1000, keys.privateKey, keyId);
      const offer = eco.createOffer("task_1", AGENT_B, token.token_id, 100);
      eco.lockEscrow(offer.offer_id, keys.privateKey, keyId);
      const escrow = eco.getEscrowByTask("task_1")!;
      eco.releaseEscrow(escrow.escrow_id, "proof_1", keys.privateKey, keyId);

      assert.deepEqual(events, ["locked", "released"]);
    });
  });
});
