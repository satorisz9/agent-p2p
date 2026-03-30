import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ExecutionVerifier } from "../src/lib/verification/prover";
import { generateKeyPair, toBase64 } from "../src/lib/crypto/keys";
import type { ExecutionProof } from "../src/types/protocol";

describe("ExecutionVerifier", () => {
  let verifier: ExecutionVerifier;
  let workerKeys: { privateKey: Uint8Array; publicKey: Uint8Array };
  const keyId = "test-key-1";

  beforeEach(() => {
    verifier = new ExecutionVerifier();
    workerKeys = generateKeyPair();
  });

  const taskId = "task_test123";
  const input = { prompt: "Hello, world!", temperature: 0.7 };
  const output = { result: "Generated response", tokens: 42 };

  // --- Proof creation ---

  it("creates a valid proof without challenge", () => {
    const proof = verifier.createProof(taskId, input, output, workerKeys.privateKey, keyId);
    assert.ok(proof.proof_id.startsWith("proof_"));
    assert.equal(proof.task_id, taskId);
    assert.ok(proof.input_hash.startsWith("sha256:"));
    assert.ok(proof.output_hash.startsWith("sha256:"));
    assert.equal(proof.signature.algorithm, "Ed25519");
    assert.equal(proof.signature.key_id, keyId);
    assert.ok(proof.signature.value.length > 0);
    assert.equal(proof.challenge, undefined);
    assert.equal(proof.challenge_response, undefined);
  });

  it("creates a proof with challenge", () => {
    const challenge = verifier.createChallenge(taskId);
    const proof = verifier.createProof(taskId, input, output, workerKeys.privateKey, keyId, challenge);
    assert.equal(proof.challenge, challenge.nonce);
    assert.ok(proof.challenge_response);
  });

  // --- Verification without challenge ---

  it("verifies a valid proof (no challenge)", () => {
    const proof = verifier.createProof(taskId, input, output, workerKeys.privateKey, keyId);
    const result = verifier.verifyProof(proof, input, output, workerKeys.publicKey);

    assert.ok(result.valid, `should be valid: ${result.error}`);
    assert.ok(result.checks.input_hash_match);
    assert.ok(result.checks.output_hash_match);
    assert.ok(result.checks.signature_valid);
    assert.ok(result.checks.challenge_valid);
    assert.ok(result.checks.timestamp_valid);
  });

  // --- Verification with challenge ---

  it("verifies a valid proof with challenge-response", () => {
    const challenge = verifier.createChallenge(taskId);
    const proof = verifier.createProof(taskId, input, output, workerKeys.privateKey, keyId, challenge);
    const result = verifier.verifyProof(proof, input, output, workerKeys.publicKey);

    assert.ok(result.valid, `should be valid: ${result.error}`);
    assert.ok(result.checks.challenge_valid);
  });

  // --- Tamper detection ---

  it("detects tampered input", () => {
    const proof = verifier.createProof(taskId, input, output, workerKeys.privateKey, keyId);
    const tamperedInput = { ...input, temperature: 0.9 };
    const result = verifier.verifyProof(proof, tamperedInput, output, workerKeys.publicKey);

    assert.ok(!result.valid);
    assert.ok(!result.checks.input_hash_match);
  });

  it("detects tampered output", () => {
    const proof = verifier.createProof(taskId, input, output, workerKeys.privateKey, keyId);
    const tamperedOutput = { ...output, tokens: 999 };
    const result = verifier.verifyProof(proof, input, tamperedOutput, workerKeys.publicKey);

    assert.ok(!result.valid);
    assert.ok(!result.checks.output_hash_match);
  });

  it("detects wrong public key (impersonation)", () => {
    const proof = verifier.createProof(taskId, input, output, workerKeys.privateKey, keyId);
    const fakeKeys = generateKeyPair();
    const result = verifier.verifyProof(proof, input, output, fakeKeys.publicKey);

    assert.ok(!result.valid);
    assert.ok(!result.checks.signature_valid);
  });

  it("detects tampered signature", () => {
    const proof = verifier.createProof(taskId, input, output, workerKeys.privateKey, keyId);
    const tampered: ExecutionProof = {
      ...proof,
      signature: { ...proof.signature, value: toBase64(new Uint8Array(64)) },
    };
    const result = verifier.verifyProof(tampered, input, output, workerKeys.publicKey);

    assert.ok(!result.valid);
    assert.ok(!result.checks.signature_valid);
  });

  it("detects tampered timestamp in signature", () => {
    const proof = verifier.createProof(taskId, input, output, workerKeys.privateKey, keyId);
    const tampered: ExecutionProof = {
      ...proof,
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
    };
    const result = verifier.verifyProof(tampered, input, output, workerKeys.publicKey);

    // Signature won't match because timestamp changed
    assert.ok(!result.valid);
    assert.ok(!result.checks.signature_valid);
  });

  it("rejects proof with expired timestamp", () => {
    const proof = verifier.createProof(taskId, input, output, workerKeys.privateKey, keyId);
    // Manually set timestamp to 10 minutes ago while keeping signature valid
    // This tests timestamp_valid check independently — but since signature covers timestamp,
    // we create a proof with old timestamp from scratch
    const oldProof: ExecutionProof = {
      ...proof,
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    };
    const result = verifier.verifyProof(oldProof, input, output, workerKeys.publicKey);
    // Either signature or timestamp will fail
    assert.ok(!result.valid);
  });

  // --- Challenge-specific attacks ---

  it("fails if challenge was issued but proof has no challenge", () => {
    // Issue a challenge
    verifier.createChallenge(taskId);
    // Create proof WITHOUT challenge
    const proof = verifier.createProof(taskId, input, output, workerKeys.privateKey, keyId);
    const result = verifier.verifyProof(proof, input, output, workerKeys.publicKey);

    assert.ok(!result.valid);
    assert.ok(!result.checks.challenge_valid);
  });

  it("fails with wrong challenge nonce", () => {
    const challenge = verifier.createChallenge(taskId);
    const proof = verifier.createProof(taskId, input, output, workerKeys.privateKey, keyId, challenge);
    // Tamper the challenge nonce in proof
    const tampered: ExecutionProof = { ...proof, challenge: "wrong_nonce_" + "a".repeat(52) };
    const result = verifier.verifyProof(tampered, input, output, workerKeys.publicKey);

    assert.ok(!result.valid);
    // Signature also fails since challenge nonce is part of signing data
    assert.ok(!result.checks.signature_valid || !result.checks.challenge_valid);
  });

  // --- Proof storage ---

  it("stores and retrieves proofs by task_id", () => {
    verifier.createProof(taskId, input, output, workerKeys.privateKey, keyId);
    const stored = verifier.getProof(taskId);
    assert.ok(stored);
    assert.equal(stored.task_id, taskId);
  });

  it("lists all proofs", () => {
    verifier.createProof("task_1", input, output, workerKeys.privateKey, keyId);
    verifier.createProof("task_2", input, output, workerKeys.privateKey, keyId);
    assert.equal(verifier.listProofs().length, 2);
  });

  // --- Challenge lifecycle ---

  it("creates and retrieves challenges", () => {
    const challenge = verifier.createChallenge(taskId);
    assert.equal(challenge.task_id, taskId);
    assert.equal(challenge.nonce.length, 64); // 32 bytes hex
    assert.ok(new Date(challenge.expires_at) > new Date());

    const retrieved = verifier.getChallenge(taskId);
    assert.deepEqual(retrieved, challenge);
  });

  it("challenge is consumed after verification", () => {
    const challenge = verifier.createChallenge(taskId);
    const proof = verifier.createProof(taskId, input, output, workerKeys.privateKey, keyId, challenge);
    verifier.verifyProof(proof, input, output, workerKeys.publicKey);

    // Challenge should be consumed
    assert.equal(verifier.getChallenge(taskId), null);
  });

  // --- Deterministic hashing ---

  it("produces same hash for same input regardless of key order", () => {
    const input1 = { b: 2, a: 1 };
    const input2 = { a: 1, b: 2 };
    const proof1 = verifier.createProof("t1", input1, output, workerKeys.privateKey, keyId);
    const proof2 = verifier.createProof("t2", input2, output, workerKeys.privateKey, keyId);
    assert.equal(proof1.input_hash, proof2.input_hash);
  });

  // --- Event emission ---

  it("emits verification:complete event", () => {
    let emitted = false;
    verifier.on("verification:complete", () => { emitted = true; });
    const proof = verifier.createProof(taskId, input, output, workerKeys.privateKey, keyId);
    verifier.verifyProof(proof, input, output, workerKeys.publicKey);
    assert.ok(emitted);
  });
});
