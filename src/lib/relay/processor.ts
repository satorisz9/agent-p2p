/**
 * Message processor — the core receive pipeline.
 *
 * Layer 1: Transport validation (signature, sender, expiry)
 * Layer 2: Schema validation
 * Layer 3: Business validation (invoice.issue only)
 * State machine transition
 * Audit logging
 */

import { v4 as uuidv4 } from "uuid";
import type {
  SignedMessage,
  InvoiceIssuePayload,
  AgentId,
} from "@/types/protocol";
import { computePayloadHash } from "@/lib/crypto";
import { validateTransport } from "@/lib/validation/transport";
import { validatePayload } from "@/lib/validation/schemas";
import { validateBusinessRules } from "@/lib/validation/business";
import { transition } from "@/lib/state/machine";
import {
  getAgent,
  storeMessage,
  setInvoiceState,
  getInvoiceState,
  appendAudit,
  markProcessed,
} from "@/lib/db/store";

export interface ProcessResult {
  accepted: boolean;
  responseType?:
    | "invoice.ack"
    | "invoice.reject"
    | "invoice.request_fix"
    | "invoice.accept";
  responsePayload?: unknown;
  error?: string;
}

/**
 * Process an incoming signed message through the full pipeline.
 */
export function processIncomingMessage(
  message: SignedMessage
): ProcessResult {
  const { envelope, payload } = message;

  // --- Store message (idempotency check) ---
  const storeResult = storeMessage(envelope, payload);
  if (!storeResult.stored) {
    return {
      accepted: false,
      responseType: "invoice.reject",
      error: "duplicate_message",
    };
  }

  // --- Layer 1: Transport validation ---
  const senderEntry = getAgent(envelope.from);
  const transportResult = validateTransport(envelope, senderEntry);
  if (!transportResult.valid) {
    markProcessed(envelope.message_id, "error");
    return {
      accepted: false,
      responseType: "invoice.reject",
      responsePayload: {
        meta: { invoice_id: extractInvoiceId(payload), currency: "JPY" },
        data: {
          reason_code: transportResult.errorCode,
          reason_message: transportResult.error,
          rejected_at: new Date().toISOString(),
          retryable: false,
        },
      },
      error: transportResult.error,
    };
  }

  // --- Payload hash verification ---
  const computedHash = computePayloadHash(payload);
  if (computedHash !== envelope.payload_hash) {
    markProcessed(envelope.message_id, "error");
    return {
      accepted: false,
      responseType: "invoice.reject",
      error: "Payload hash mismatch",
    };
  }

  // --- Layer 2: Schema validation ---
  const schemaResult = validatePayload(envelope.message_type, payload);
  if (!schemaResult.valid) {
    markProcessed(envelope.message_id, "error");
    return {
      accepted: false,
      responseType: "invoice.reject",
      responsePayload: {
        meta: { invoice_id: extractInvoiceId(payload), currency: "JPY" },
        data: {
          reason_code: "invalid_schema",
          reason_message: schemaResult.errors?.join("; ") ?? "Schema validation failed",
          rejected_at: new Date().toISOString(),
          retryable: true,
        },
      },
      error: schemaResult.errors?.join("; "),
    };
  }

  // --- For invoice.issue: Layer 3 business validation ---
  if (envelope.message_type === "invoice.issue") {
    return processInvoiceIssue(envelope.message_id, envelope, payload as InvoiceIssuePayload);
  }

  // --- For other message types: apply state transition ---
  const invoiceId = extractInvoiceId(payload);
  if (invoiceId) {
    applyStateTransition(invoiceId, envelope);
  }

  markProcessed(envelope.message_id, "processed");
  return {
    accepted: true,
    responseType: "invoice.ack",
  };
}

function processInvoiceIssue(
  messageId: string,
  envelope: SignedMessage["envelope"],
  payload: InvoiceIssuePayload
): ProcessResult {
  const invoiceId = payload.meta.invoice_id;

  // Check duplicate invoice
  const existing = getInvoiceState(invoiceId);
  if (existing && existing.current_state !== "fix_requested") {
    markProcessed(messageId, "error");
    return {
      accepted: false,
      responseType: "invoice.reject",
      responsePayload: {
        meta: payload.meta,
        data: {
          reason_code: "duplicate_invoice",
          reason_message: `Invoice ${invoiceId} already exists in state: ${existing.current_state}`,
          rejected_at: new Date().toISOString(),
          retryable: false,
        },
      },
    };
  }

  // Business validation
  const bizResult = validateBusinessRules(payload);
  if (!bizResult.valid) {
    setInvoiceState(invoiceId, "fix_requested", messageId, {
      seller_org_id: payload.data.seller.org_id,
      buyer_org_id: payload.data.buyer.org_id,
      total_amount: payload.data.total,
      currency: payload.meta.currency,
    });
    logAudit(invoiceId, "invoice.request_fix", envelope.to, messageId);
    markProcessed(messageId, "processed");
    return {
      accepted: false,
      responseType: "invoice.request_fix",
      responsePayload: {
        meta: payload.meta,
        data: {
          requested_at: new Date().toISOString(),
          issues: bizResult.fixableIssues,
          suggested_action: "Please amend and resend the invoice.",
        },
      },
    };
  }

  // All validations passed — accept
  setInvoiceState(invoiceId, "accepted", messageId, {
    seller_org_id: payload.data.seller.org_id,
    buyer_org_id: payload.data.buyer.org_id,
    total_amount: payload.data.total,
    currency: payload.meta.currency,
  });
  logAudit(invoiceId, "invoice.accepted", envelope.to, messageId);
  markProcessed(messageId, "processed");

  return {
    accepted: true,
    responseType: "invoice.accept",
    responsePayload: {
      meta: payload.meta,
      data: {
        accepted_at: new Date().toISOString(),
        accepted_by_agent: envelope.to,
        payment_status: "scheduled",
        internal_reference: `AP-${Date.now()}`,
      },
    },
  };
}

function applyStateTransition(
  invoiceId: string,
  envelope: SignedMessage["envelope"]
): void {
  const current = getInvoiceState(invoiceId);
  if (!current) return;

  const result = transition(current.current_state, envelope.message_type);
  if (result.ok && result.nextState) {
    setInvoiceState(invoiceId, result.nextState, envelope.message_id);
    logAudit(invoiceId, envelope.message_type, envelope.to, envelope.message_id);
  }
}

function logAudit(
  invoiceId: string,
  eventType: string,
  actorId: string,
  sourceMessageId: string
): void {
  appendAudit({
    event_id: `evt_${uuidv4().replace(/-/g, "")}`,
    invoice_id: invoiceId,
    event_type: eventType,
    actor_type: "agent",
    actor_id: actorId,
    source_message_id: sourceMessageId,
    timestamp: new Date().toISOString(),
    details: {},
  });
}

function extractInvoiceId(payload: unknown): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "meta" in payload &&
    typeof (payload as { meta: { invoice_id?: string } }).meta === "object"
  ) {
    return (
      (payload as { meta: { invoice_id?: string } }).meta.invoice_id ?? ""
    );
  }
  return "";
}
