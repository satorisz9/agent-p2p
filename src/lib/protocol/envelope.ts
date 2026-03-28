import { v4 as uuidv4 } from "uuid";
import type { AgentId, Envelope, MessageType } from "@/types/protocol";
import { computePayloadHash, signEnvelope } from "@/lib/crypto";

const SCHEMA_VERSION = "0.1.0";

export interface BuildEnvelopeParams {
  from: AgentId;
  to: AgentId;
  messageType: MessageType;
  threadId: string;
  idempotencyKey: string;
  correlationId?: string | null;
  replyToMessageId?: string | null;
  expiresAt?: string | null;
}

/**
 * Build a complete signed envelope for a payload.
 */
export function buildSignedEnvelope(
  params: BuildEnvelopeParams,
  payload: unknown,
  privateKey: Uint8Array,
  keyId: string
): Envelope {
  const payloadHash = computePayloadHash(payload);

  const envelope: Envelope = {
    message_id: `msg_${uuidv4().replace(/-/g, "")}`,
    thread_id: params.threadId,
    from: params.from,
    to: params.to,
    message_type: params.messageType,
    schema_version: SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    idempotency_key: params.idempotencyKey,
    correlation_id: params.correlationId ?? null,
    reply_to_message_id: params.replyToMessageId ?? null,
    expires_at: params.expiresAt ?? null,
    payload_hash: payloadHash,
    // placeholder — will be replaced by actual signature
    signature: { algorithm: "Ed25519", key_id: keyId, value: "" },
  };

  envelope.signature = signEnvelope(envelope, privateKey, keyId);
  return envelope;
}
