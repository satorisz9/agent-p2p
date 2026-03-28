import type { Envelope, AgentRegistryEntry } from "@/types/protocol";
import { verifyEnvelope } from "@/lib/crypto";
import { fromBase64 } from "@/lib/crypto";

export interface TransportValidationResult {
  valid: boolean;
  error?: string;
  errorCode?: string;
}

/**
 * Layer 1: Transport validation.
 * - Signature verification
 * - Expiry check
 * - Sender registry lookup
 * - Capability check
 */
export function validateTransport(
  envelope: Envelope,
  senderEntry: AgentRegistryEntry | null
): TransportValidationResult {
  // Check sender exists in registry
  if (!senderEntry) {
    return {
      valid: false,
      error: `Unknown sender: ${envelope.from}`,
      errorCode: "unknown_sender",
    };
  }

  // Check sender is active
  if (senderEntry.status !== "active") {
    return {
      valid: false,
      error: `Sender ${envelope.from} is ${senderEntry.status}`,
      errorCode: "unknown_sender",
    };
  }

  // Check capability
  if (!senderEntry.capabilities.includes(envelope.message_type)) {
    return {
      valid: false,
      error: `Sender lacks capability: ${envelope.message_type}`,
      errorCode: "unauthorized_capability",
    };
  }

  // Check expiry
  if (envelope.expires_at) {
    const expiresAt = new Date(envelope.expires_at);
    if (expiresAt < new Date()) {
      return {
        valid: false,
        error: "Message has expired",
        errorCode: "expired_message",
      };
    }
  }

  // Verify signature
  const publicKey = fromBase64(senderEntry.public_key);
  const signatureValid = verifyEnvelope(envelope, publicKey);
  if (!signatureValid) {
    return {
      valid: false,
      error: "Invalid signature",
      errorCode: "invalid_signature",
    };
  }

  return { valid: true };
}
