/**
 * In-memory store for MVP.
 * Replace with Postgres in production.
 */

import type {
  AgentRegistryEntry,
  Envelope,
  InvoiceState,
  AuditEvent,
  AgentId,
  SignedMessage,
} from "@/types/protocol";

// --- Agent Registry ---

const agentRegistry = new Map<string, AgentRegistryEntry>();

export function registerAgent(entry: AgentRegistryEntry): void {
  agentRegistry.set(entry.agent_id, entry);
}

export function getAgent(agentId: string): AgentRegistryEntry | null {
  return agentRegistry.get(agentId) ?? null;
}

export function listAgents(): AgentRegistryEntry[] {
  return Array.from(agentRegistry.values());
}

// --- Messages ---

interface StoredMessage {
  envelope: Envelope;
  payload: unknown;
  transport_status: "queued" | "delivered" | "failed";
  processing_status: "pending" | "processed" | "error";
  stored_at: string;
}

const messages = new Map<string, StoredMessage>();

export function storeMessage(
  envelope: Envelope,
  payload: unknown
): { stored: boolean; error?: string } {
  // Idempotency check
  const idempKey = `${envelope.from}:${envelope.to}:${envelope.message_type}:${envelope.idempotency_key}`;
  for (const msg of messages.values()) {
    const existingKey = `${msg.envelope.from}:${msg.envelope.to}:${msg.envelope.message_type}:${msg.envelope.idempotency_key}`;
    if (existingKey === idempKey) {
      return { stored: false, error: "duplicate_message" };
    }
  }

  messages.set(envelope.message_id, {
    envelope,
    payload,
    transport_status: "queued",
    processing_status: "pending",
    stored_at: new Date().toISOString(),
  });
  return { stored: true };
}

export function getMessage(
  messageId: string
): { envelope: Envelope; payload: unknown } | null {
  const msg = messages.get(messageId);
  if (!msg) return null;
  return { envelope: msg.envelope, payload: msg.payload };
}

export function getMailbox(
  agentId: AgentId,
  status?: "queued" | "delivered"
): SignedMessage[] {
  const result: SignedMessage[] = [];
  for (const msg of messages.values()) {
    if (msg.envelope.to !== agentId) continue;
    if (status && msg.transport_status !== status) continue;
    result.push({ envelope: msg.envelope, payload: msg.payload });
  }
  return result;
}

export function ackDelivery(messageId: string): boolean {
  const msg = messages.get(messageId);
  if (!msg) return false;
  msg.transport_status = "delivered";
  return true;
}

export function markProcessed(
  messageId: string,
  status: "processed" | "error"
): void {
  const msg = messages.get(messageId);
  if (msg) msg.processing_status = status;
}

// --- Invoice State ---

interface InvoiceRecord {
  invoice_id: string;
  seller_org_id: string;
  buyer_org_id: string;
  current_state: InvoiceState;
  total_amount: number;
  currency: string;
  last_message_id: string;
  updated_at: string;
}

const invoiceStates = new Map<string, InvoiceRecord>();

export function setInvoiceState(
  invoiceId: string,
  state: InvoiceState,
  messageId: string,
  extra?: Partial<InvoiceRecord>
): void {
  const existing = invoiceStates.get(invoiceId);
  if (existing) {
    existing.current_state = state;
    existing.last_message_id = messageId;
    existing.updated_at = new Date().toISOString();
  } else {
    invoiceStates.set(invoiceId, {
      invoice_id: invoiceId,
      seller_org_id: extra?.seller_org_id ?? "",
      buyer_org_id: extra?.buyer_org_id ?? "",
      current_state: state,
      total_amount: extra?.total_amount ?? 0,
      currency: extra?.currency ?? "JPY",
      last_message_id: messageId,
      updated_at: new Date().toISOString(),
    });
  }
}

export function getInvoiceState(
  invoiceId: string
): InvoiceRecord | null {
  return invoiceStates.get(invoiceId) ?? null;
}

export function listInvoices(): InvoiceRecord[] {
  return Array.from(invoiceStates.values());
}

// --- Audit Events ---

const auditEvents: AuditEvent[] = [];

export function appendAudit(event: AuditEvent): void {
  auditEvents.push(event);
}

export function getAuditLog(invoiceId?: string): AuditEvent[] {
  if (!invoiceId) return [...auditEvents];
  return auditEvents.filter((e) => e.invoice_id === invoiceId);
}
