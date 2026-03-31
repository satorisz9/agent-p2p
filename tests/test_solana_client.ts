/**
 * SolanaClient Unit Tests — tests all logic without requiring devnet access.
 *
 * Tests keypair derivation, explorer URLs, network config, and error handling.
 * On-chain operations are tested via E2E when devnet funding is available.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { SolanaClient } from "../src/lib/chain/solana";
import { generateKeyPair, toBase64 } from "../src/lib/crypto/keys";

describe("SolanaClient", () => {
  describe("keypair derivation", () => {
    it("derives Solana keypair from Ed25519 64-byte key", () => {
      const solana = new SolanaClient({ network: "devnet" });
      const ed25519 = generateKeyPair();
      // Ed25519 keypair is 64 bytes (32 seed + 32 pub)
      const combined = new Uint8Array(64);
      combined.set(ed25519.privateKey.slice(0, 32), 0);
      combined.set(ed25519.publicKey, 32);
      const base64Key = Buffer.from(combined).toString("base64");

      const kp = solana.keypairFromPrivateKey(base64Key);
      assert.ok(kp.publicKey.toBase58().length > 30, "Should produce valid Solana address");
    });

    it("derives same keypair from same key deterministically", () => {
      const solana = new SolanaClient({ network: "devnet" });
      const ed25519 = generateKeyPair();
      const combined = new Uint8Array(64);
      combined.set(ed25519.privateKey.slice(0, 32), 0);
      combined.set(ed25519.publicKey, 32);
      const base64Key = Buffer.from(combined).toString("base64");

      const kp1 = solana.keypairFromPrivateKey(base64Key);
      const kp2 = solana.keypairFromPrivateKey(base64Key);
      assert.equal(kp1.publicKey.toBase58(), kp2.publicKey.toBase58());
    });

    it("different agent keys produce different Solana addresses", () => {
      const solana = new SolanaClient({ network: "devnet" });
      const key1 = generateKeyPair();
      const key2 = generateKeyPair();

      const make64 = (kp: { privateKey: Uint8Array; publicKey: Uint8Array }) => {
        const combined = new Uint8Array(64);
        combined.set(kp.privateKey.slice(0, 32), 0);
        combined.set(kp.publicKey, 32);
        return Buffer.from(combined).toString("base64");
      };

      const addr1 = solana.keypairFromPrivateKey(make64(key1)).publicKey.toBase58();
      const addr2 = solana.keypairFromPrivateKey(make64(key2)).publicKey.toBase58();
      assert.notEqual(addr1, addr2);
    });

    it("derives from 32-byte seed", () => {
      const solana = new SolanaClient({ network: "devnet" });
      const seed = Buffer.from(Keypair.generate().secretKey.slice(0, 32));
      const kp = solana.keypairFromPrivateKey(seed.toString("base64"));
      assert.ok(kp.publicKey.toBase58().length > 30);
    });

    it("rejects invalid key length", () => {
      const solana = new SolanaClient({ network: "devnet" });
      assert.throws(
        () => solana.keypairFromPrivateKey(Buffer.from("short").toString("base64")),
        /Invalid private key length/
      );
    });
  });

  describe("generateKeypair", () => {
    it("generates valid keypair", () => {
      const solana = new SolanaClient({ network: "devnet" });
      const kp = solana.generateKeypair();
      assert.ok(kp.publicKey.toBase58().length > 30);
      assert.equal(kp.secretKey.length, 64);
    });

    it("generates unique keypairs", () => {
      const solana = new SolanaClient({ network: "devnet" });
      const kp1 = solana.generateKeypair();
      const kp2 = solana.generateKeypair();
      assert.notEqual(kp1.publicKey.toBase58(), kp2.publicKey.toBase58());
    });
  });

  describe("explorer URLs", () => {
    it("devnet URLs include cluster=devnet", () => {
      const solana = new SolanaClient({ network: "devnet" });
      const url = solana.explorerUrl("tx", "fakesig123");
      assert.ok(url.includes("solscan.io/tx/fakesig123"));
      assert.ok(url.includes("cluster=devnet"));
    });

    it("mainnet URLs have no cluster param", () => {
      const solana = new SolanaClient({ network: "mainnet-beta" });
      const url = solana.explorerUrl("address", "FakeAddress123");
      assert.ok(url.includes("solscan.io/address/FakeAddress123"));
      assert.ok(!url.includes("cluster="));
    });

    it("supports tx and address types", () => {
      const solana = new SolanaClient({ network: "devnet" });
      assert.ok(solana.explorerUrl("tx", "sig").includes("/tx/sig"));
      assert.ok(solana.explorerUrl("address", "addr").includes("/address/addr"));
    });
  });

  describe("network config", () => {
    it("reports correct network", () => {
      const devnet = new SolanaClient({ network: "devnet" });
      assert.equal(devnet.getNetwork(), "devnet");

      const mainnet = new SolanaClient({ network: "mainnet-beta" });
      assert.equal(mainnet.getNetwork(), "mainnet-beta");
    });

    it("accepts custom RPC URL", () => {
      // Should not throw
      const client = new SolanaClient({
        network: "devnet",
        rpcUrl: "https://custom-rpc.example.com",
      });
      assert.equal(client.getNetwork(), "devnet");
    });
  });

  describe("airdrop validation", () => {
    it("rejects airdrop on mainnet", async () => {
      const solana = new SolanaClient({ network: "mainnet-beta" });
      await assert.rejects(
        () => solana.airdrop("FakeAddress", 1),
        /only available on devnet/
      );
    });
  });
});
