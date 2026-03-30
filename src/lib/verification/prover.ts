/**
 * Execution Verification — cryptographic proof of task results.
 *
 * Flow:
 *   1. Requester sends ExecutionChallenge with random nonce (optional)
 *   2. Worker executes task
 *   3. Worker creates ExecutionProof:
 *      - Hashes input & output (SHA-256 canonical JSON)
 *      - Signs (task_id + input_hash + output_hash + timestamp [+ challenge])
 *      - Returns proof with result
 *   4. Requester verifies:
 *      - Input hash matches what was sent
 *      - Output hash matches what was received
 *      - Signature is valid against worker's public key
 *      - Challenge response is correct (if challenge was issued)
 *      - Timestamp is within acceptable range
 */

import { createHash, randomBytes } from "crypto";
import { EventEmitter } from "events";
import type {
  AgentId,
  Signature,
  ExecutionProof,
  ExecutionChallenge,
  VerificationResult,
} from "../../types/protocol";
import { canonicalJson, computePayloadHash } from "../crypto/signing";
import { sign, verify, toBase64, fromBase64 } from "../crypto/keys";

/** Max age of a proof timestamp to be considered valid (5 minutes) */
const MAX_PROOF_AGE_MS = 5 * 60 * 1000;
/** Default challenge TTL (2 minutes) */
const DEFAULT_CHALLENGE_TTL_MS = 2 * 60 * 1000;

export class ExecutionVerifier extends EventEmitter {
  private pendingChallenges = new Map<string, ExecutionChallenge>();
  private proofs = new Map<string, ExecutionProof>();

  // --- Challenge (requester side) ---

  /** Create a challenge to send to worker before task execution */
  createChallenge(taskId: string, ttlMs = DEFAULT_CHALLENGE_TTL_MS): ExecutionChallenge {
    const challenge: ExecutionChallenge = {
      task_id: taskId,
      nonce: randomBytes(32).toString("hex"),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
    };
    this.pendingChallenges.set(taskId, challenge);
    return challenge;
  }

  /** Get pending challenge for a task */
  getChallenge(taskId: string): ExecutionChallenge | null {
    return this.pendingChallenges.get(taskId) ?? null;
  }

  // --- Proof Creation (worker side) ---

  /** Create an execution proof for a completed task */
  createProof(
    taskId: string,
    input: Record<string, unknown>,
    output: Record<string, unknown>,
    privateKey: Uint8Array,
    keyId: string,
    challenge?: ExecutionChallenge
  ): ExecutionProof {
    const inputHash = hashObject(input);
    const outputHash = hashObject(output);
    const timestamp = new Date().toISOString();
    const proofId = `proof_${randomBytes(16).toString("hex")}`;

    // Build signing input
    let signingData = `${taskId}:${inputHash}:${outputHash}:${timestamp}`;
    let challengeResponse: string | undefined;

    if (challenge) {
      // Include challenge nonce in signature to prove work was done after challenge
      signingData += `:${challenge.nonce}`;
      // Challenge response = hash(nonce + output_hash) — proves output was computed with knowledge of nonce
      challengeResponse = createHash("sha256")
        .update(challenge.nonce + outputHash)
        .digest("hex");
    }

    const sigBytes = sign(
      new TextEncoder().encode(signingData),
      privateKey
    );

    const proof: ExecutionProof = {
      proof_id: proofId,
      task_id: taskId,
      input_hash: inputHash,
      output_hash: outputHash,
      signature: {
        algorithm: "Ed25519",
        key_id: keyId,
        value: toBase64(sigBytes),
      },
      timestamp,
      challenge: challenge?.nonce,
      challenge_response: challengeResponse,
    };

    this.proofs.set(taskId, proof);
    return proof;
  }

  // --- Verification (requester side) ---

  /** Verify an execution proof against known input, received output, and worker's public key */
  verifyProof(
    proof: ExecutionProof,
    expectedInput: Record<string, unknown>,
    receivedOutput: Record<string, unknown>,
    workerPublicKey: Uint8Array
  ): VerificationResult {
    const checks = {
      input_hash_match: false,
      output_hash_match: false,
      signature_valid: false,
      challenge_valid: false,
      timestamp_valid: false,
    };

    // 1. Verify input hash
    const expectedInputHash = hashObject(expectedInput);
    checks.input_hash_match = proof.input_hash === expectedInputHash;

    // 2. Verify output hash
    const receivedOutputHash = hashObject(receivedOutput);
    checks.output_hash_match = proof.output_hash === receivedOutputHash;

    // 3. Verify timestamp is recent
    const proofAge = Date.now() - new Date(proof.timestamp).getTime();
    checks.timestamp_valid = proofAge >= 0 && proofAge < MAX_PROOF_AGE_MS;

    // 4. Verify signature
    let signingData = `${proof.task_id}:${proof.input_hash}:${proof.output_hash}:${proof.timestamp}`;
    if (proof.challenge) {
      signingData += `:${proof.challenge}`;
    }

    try {
      const sigBytes = fromBase64(proof.signature.value);
      checks.signature_valid = verify(
        sigBytes,
        new TextEncoder().encode(signingData),
        workerPublicKey
      );
    } catch {
      checks.signature_valid = false;
    }

    // 5. Verify challenge response (if challenge was issued)
    const pendingChallenge = this.pendingChallenges.get(proof.task_id);
    if (pendingChallenge) {
      if (!proof.challenge || !proof.challenge_response) {
        checks.challenge_valid = false;
      } else {
        // Verify nonce matches
        const nonceMatch = proof.challenge === pendingChallenge.nonce;
        // Verify challenge not expired
        const notExpired = new Date(pendingChallenge.expires_at).getTime() > Date.now();
        // Verify response = hash(nonce + output_hash)
        const expectedResponse = createHash("sha256")
          .update(pendingChallenge.nonce + proof.output_hash)
          .digest("hex");
        const responseMatch = proof.challenge_response === expectedResponse;

        checks.challenge_valid = nonceMatch && notExpired && responseMatch;
      }
      // Clean up used challenge
      this.pendingChallenges.delete(proof.task_id);
    } else {
      // No challenge was issued — challenge check passes by default
      checks.challenge_valid = true;
    }

    const valid = checks.input_hash_match
      && checks.output_hash_match
      && checks.signature_valid
      && checks.challenge_valid
      && checks.timestamp_valid;

    const result: VerificationResult = {
      valid,
      proof_id: proof.proof_id,
      task_id: proof.task_id,
      checks,
      error: valid ? undefined : this.describeFailure(checks),
    };

    this.emit("verification:complete", result);
    return result;
  }

  // --- Query ---

  getProof(taskId: string): ExecutionProof | null {
    return this.proofs.get(taskId) ?? null;
  }

  listProofs(): ExecutionProof[] {
    return Array.from(this.proofs.values());
  }

  // --- Helpers ---

  private describeFailure(checks: VerificationResult["checks"]): string {
    const failures: string[] = [];
    if (!checks.input_hash_match) failures.push("input hash mismatch");
    if (!checks.output_hash_match) failures.push("output hash mismatch");
    if (!checks.signature_valid) failures.push("invalid signature");
    if (!checks.challenge_valid) failures.push("challenge verification failed");
    if (!checks.timestamp_valid) failures.push("timestamp out of range");
    return failures.join(", ");
  }

  destroy(): void {
    this.pendingChallenges.clear();
    this.proofs.clear();
    this.removeAllListeners();
  }
}

/** Hash an object using SHA-256 of its canonical JSON */
function hashObject(obj: Record<string, unknown>): string {
  const canonical = canonicalJson(obj);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
