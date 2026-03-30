import { validateBusinessRules } from "../lib/validation/business";
import { transition } from "../lib/state/machine";

import type {
  AgentId,
  Envelope,
  InvoiceIssuePayload,
  InvoiceState,
  MessageType,
  SignedMessage,
} from "../types/protocol";

export interface BillingInvoiceRecord {
  state: InvoiceState;
  payload?: unknown;
  lastMessageId: string;
  updatedAt: string;
}

export interface BillingAuditEntry {
  timestamp: string;
  event: string;
  invoiceId?: string;
  details: Record<string, unknown>;
}

export interface BillingState {
  invoices: Record<string, BillingInvoiceRecord>;
  auditLog: BillingAuditEntry[];
}

interface BillingEnvelopeParams {
  to: AgentId;
  messageType: MessageType;
  threadId: string;
  idempotencyKey: string;
  replyToMessageId?: string;
}

interface BillingServiceDeps {
  agentId: AgentId;
  getState: () => BillingState;
  sendMessage: (targetAgentId: AgentId, message: SignedMessage) => boolean;
  buildEnvelope: (params: BillingEnvelopeParams, payload: unknown) => Envelope;
  audit: (event: string, invoiceId?: string, details?: Record<string, unknown>) => void;
  saveState: () => void;
}

export class BillingService {
  constructor(private readonly deps: BillingServiceDeps) {}

  issueInvoice(
    targetAgentId: AgentId,
    invoicePayload: InvoiceIssuePayload
  ): { success: boolean; messageId?: string; error?: string } {
    const state = this.deps.getState();
    const invoiceId = invoicePayload.meta.invoice_id;

    const envelope = this.deps.buildEnvelope({
      to: targetAgentId,
      messageType: "invoice.issue",
      threadId: `thr_${invoiceId}`,
      idempotencyKey: `issue-${invoiceId}-v1`,
    }, invoicePayload);

    const message: SignedMessage = { envelope, payload: invoicePayload };
    const sent = this.deps.sendMessage(targetAgentId, message);
    if (!sent) {
      return {
        success: false,
        error: `Peer ${targetAgentId} not connected. Message queued for retry.`,
        messageId: envelope.message_id,
      };
    }

    state.invoices[invoiceId] = {
      state: "issued",
      payload: invoicePayload,
      lastMessageId: envelope.message_id,
      updatedAt: new Date().toISOString(),
    };
    this.deps.audit("invoice.issued", invoiceId, { to: targetAgentId });
    this.deps.saveState();

    return { success: true, messageId: envelope.message_id };
  }

  acceptInvoice(
    invoiceId: string,
    scheduledPaymentDate?: string
  ): { success: boolean; error?: string } {
    const state = this.deps.getState();
    const invoice = state.invoices[invoiceId];
    if (!invoice) {
      return { success: false, error: "Invoice not found" };
    }

    const trans = transition(invoice.state, "invoice.accept");
    if (!trans.ok) {
      return { success: false, error: trans.error };
    }

    invoice.state = trans.nextState!;
    invoice.updatedAt = new Date().toISOString();

    const acceptPayload = {
      meta: { invoice_id: invoiceId, currency: "JPY" as const },
      data: {
        accepted_at: new Date().toISOString(),
        accepted_by_agent: this.deps.agentId,
        payment_status: "scheduled" as const,
        scheduled_payment_date: scheduledPaymentDate,
      },
    };

    const issuerAgentId = this.findIssuerAgent(invoiceId);
    if (issuerAgentId) {
      const envelope = this.deps.buildEnvelope({
        to: issuerAgentId,
        messageType: "invoice.accept",
        threadId: `thr_${invoiceId}`,
        idempotencyKey: `accept-${invoiceId}`,
      }, acceptPayload);
      this.deps.sendMessage(issuerAgentId, { envelope, payload: acceptPayload });
    }

    this.deps.audit("invoice.accepted", invoiceId, { scheduledPaymentDate });
    this.deps.saveState();
    return { success: true };
  }

  rejectInvoice(
    invoiceId: string,
    reasonCode: string,
    reasonMessage: string
  ): { success: boolean; error?: string } {
    const state = this.deps.getState();
    const invoice = state.invoices[invoiceId];
    if (!invoice) {
      return { success: false, error: "Invoice not found" };
    }

    const trans = transition(invoice.state, "invoice.reject");
    if (!trans.ok) {
      return { success: false, error: trans.error };
    }

    invoice.state = trans.nextState!;
    invoice.updatedAt = new Date().toISOString();

    this.deps.audit("invoice.rejected", invoiceId, { reasonCode, reasonMessage });
    this.deps.saveState();
    return { success: true };
  }

  getInvoice(invoiceId: string): BillingInvoiceRecord | null {
    const state = this.deps.getState();
    return state.invoices[invoiceId] ?? null;
  }

  listInvoices(): Array<{ invoice_id: string; state: InvoiceState; updated_at: string }> {
    const state = this.deps.getState();
    return Object.entries(state.invoices).map(([id, invoice]) => ({
      invoice_id: id,
      state: invoice.state,
      updated_at: invoice.updatedAt,
    }));
  }

  handleInvoiceIssue(
    envelope: Envelope,
    payload: InvoiceIssuePayload
  ): { processed: boolean; action: string; invoiceId: string; details: unknown } {
    const state = this.deps.getState();
    const invoiceId = payload.meta.invoice_id;

    if (state.invoices[invoiceId]) {
      return {
        processed: true,
        action: "rejected_duplicate",
        invoiceId,
        details: `Invoice ${invoiceId} already exists`,
      };
    }

    const bizResult = validateBusinessRules(payload);
    if (!bizResult.valid) {
      state.invoices[invoiceId] = {
        state: "fix_requested",
        payload,
        lastMessageId: envelope.message_id,
        updatedAt: new Date().toISOString(),
      };
      this.deps.audit("invoice.fix_requested", invoiceId, {
        issues: bizResult.fixableIssues,
      });
      return {
        processed: true,
        action: "request_fix",
        invoiceId,
        details: bizResult.fixableIssues,
      };
    }

    state.invoices[invoiceId] = {
      state: "validated",
      payload,
      lastMessageId: envelope.message_id,
      updatedAt: new Date().toISOString(),
    };
    this.deps.audit("invoice.received_and_validated", invoiceId, {
      from: envelope.from,
      total: payload.data.total,
    });

    return {
      processed: true,
      action: "validated",
      invoiceId,
      details: {
        from: envelope.from,
        total: payload.data.total,
        currency: payload.meta.currency,
      },
    };
  }

  handleStateUpdate(
    envelope: Envelope,
    payload: unknown
  ): { processed: boolean; action: string; invoiceId?: string; details: unknown } {
    const state = this.deps.getState();
    const meta = (payload as any)?.meta;
    const invoiceId = meta?.invoice_id;
    if (!invoiceId || !state.invoices[invoiceId]) {
      return { processed: true, action: "ignored", details: "Unknown invoice" };
    }

    const invoice = state.invoices[invoiceId];
    const trans = transition(invoice.state, envelope.message_type);
    if (!trans.ok) {
      return {
        processed: true,
        action: "ignored",
        invoiceId,
        details: trans.error,
      };
    }

    invoice.state = trans.nextState!;
    invoice.lastMessageId = envelope.message_id;
    invoice.updatedAt = new Date().toISOString();
    this.deps.audit(envelope.message_type, invoiceId, { payload });

    return {
      processed: true,
      action: envelope.message_type,
      invoiceId,
      details: { newState: trans.nextState },
    };
  }

  private findIssuerAgent(invoiceId: string): AgentId | null {
    const state = this.deps.getState();
    const entry = state.auditLog.find(
      (audit) => audit.invoiceId === invoiceId && audit.event === "invoice.received_and_validated"
    );
    return (entry?.details?.from as AgentId) ?? null;
  }
}
