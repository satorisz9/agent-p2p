import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { transition } from "../lib/state/machine";
import { validateBusinessRules } from "../lib/validation/business";
import { validatePayload } from "../lib/validation/schemas";
import { computePayloadHash } from "../lib/crypto/signing";

import { P2PAgent } from "./core";

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

const BILLING_MESSAGE_TYPES = new Set<MessageType>([
  "invoice.issue",
  "invoice.accept",
  "invoice.reject",
  "invoice.request_fix",
  "payment.notice",
]);

export class BillingPlugin {
  private state: BillingState = {
    invoices: {},
    auditLog: [],
  };
  private readonly stateFile: string;
  private readonly handleInboxMessageBound: (message: SignedMessage) => void;

  constructor(private readonly agent: P2PAgent) {
    this.stateFile = join(this.agent.getDataDir(), "billing-state.json");
    this.handleInboxMessageBound = (message) => {
      this.handleInboxMessage(message);
    };
  }

  start(): void {
    this.loadOrCreateState();
    this.agent.on("inbox:new", this.handleInboxMessageBound);
  }

  stop(): void {
    this.agent.off("inbox:new", this.handleInboxMessageBound);
    this.saveState();
  }

  issueInvoice(
    targetAgentId: AgentId,
    invoicePayload: InvoiceIssuePayload
  ): { success: boolean; messageId?: string; error?: string } {
    const invoiceId = invoicePayload.meta.invoice_id;
    const message = this.agent.createSignedMessage(
      {
        to: targetAgentId,
        messageType: "invoice.issue",
        threadId: `thr_${invoiceId}`,
        idempotencyKey: `issue-${invoiceId}-v1`,
      },
      invoicePayload
    );

    const sent = this.agent.sendSignedMessage(targetAgentId, message);
    if (!sent) {
      return {
        success: false,
        error: `Peer ${targetAgentId} not connected. Message queued for retry.`,
        messageId: message.envelope.message_id,
      };
    }

    this.state.invoices[invoiceId] = {
      state: "issued",
      payload: invoicePayload,
      lastMessageId: message.envelope.message_id,
      updatedAt: new Date().toISOString(),
    };
    this.audit("invoice.issued", invoiceId, { to: targetAgentId });
    this.saveState();

    return { success: true, messageId: message.envelope.message_id };
  }

  acceptInvoice(
    invoiceId: string,
    scheduledPaymentDate?: string
  ): { success: boolean; error?: string } {
    const invoice = this.state.invoices[invoiceId];
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
        accepted_by_agent: this.agent.getAgentInfo().agent_id,
        payment_status: "scheduled" as const,
        scheduled_payment_date: scheduledPaymentDate,
      },
    };

    const issuerAgentId = this.findIssuerAgent(invoiceId);
    if (issuerAgentId) {
      const message = this.agent.createSignedMessage(
        {
          to: issuerAgentId,
          messageType: "invoice.accept",
          threadId: `thr_${invoiceId}`,
          idempotencyKey: `accept-${invoiceId}`,
        },
        acceptPayload
      );
      this.agent.sendSignedMessage(issuerAgentId, message);
    }

    this.audit("invoice.accepted", invoiceId, { scheduledPaymentDate });
    this.saveState();
    return { success: true };
  }

  rejectInvoice(
    invoiceId: string,
    reasonCode: string,
    reasonMessage: string
  ): { success: boolean; error?: string } {
    const invoice = this.state.invoices[invoiceId];
    if (!invoice) {
      return { success: false, error: "Invoice not found" };
    }

    const trans = transition(invoice.state, "invoice.reject");
    if (!trans.ok) {
      return { success: false, error: trans.error };
    }

    invoice.state = trans.nextState!;
    invoice.updatedAt = new Date().toISOString();
    this.audit("invoice.rejected", invoiceId, { reasonCode, reasonMessage });
    this.saveState();
    return { success: true };
  }

  getInvoice(invoiceId: string): BillingInvoiceRecord | null {
    return this.state.invoices[invoiceId] ?? null;
  }

  listInvoices(): Array<{ invoice_id: string; state: InvoiceState; updated_at: string }> {
    return Object.entries(this.state.invoices).map(([invoiceId, invoice]) => ({
      invoice_id: invoiceId,
      state: invoice.state,
      updated_at: invoice.updatedAt,
    }));
  }

  getAuditLog(invoiceId?: string): BillingAuditEntry[] {
    if (invoiceId) {
      return this.state.auditLog.filter((entry) => entry.invoiceId === invoiceId);
    }
    return this.state.auditLog.slice(-50);
  }

  private handleInboxMessage(message: SignedMessage): void {
    if (!BILLING_MESSAGE_TYPES.has(message.envelope.message_type)) {
      return;
    }

    const result = this.processMessage(message);
    if (result.processed) {
      this.agent.acknowledgeInboxMessage(message.envelope.message_id);
      this.saveState();
    }
  }

  private processMessage(message: SignedMessage): {
    processed: boolean;
    action?: string;
    details?: unknown;
  } {
    const { envelope, payload } = message;
    const invoiceId = this.getInvoiceId(payload);

    if (computePayloadHash(payload) !== envelope.payload_hash) {
      this.audit("invoice.rejected", invoiceId, { reason: "Payload hash mismatch" });
      return {
        processed: true,
        action: "rejected",
        details: "Payload hash mismatch",
      };
    }

    const schemaResult = validatePayload(envelope.message_type, payload);
    if (!schemaResult.valid) {
      this.audit("invoice.rejected", invoiceId, { reason: "Schema validation failed", errors: schemaResult.errors });
      return {
        processed: true,
        action: "rejected",
        details: schemaResult.errors,
      };
    }

    switch (envelope.message_type) {
      case "invoice.issue":
        return this.handleInvoiceIssue(envelope, payload as InvoiceIssuePayload);
      case "invoice.accept":
      case "invoice.reject":
      case "invoice.request_fix":
      case "payment.notice":
        return this.handleStateUpdate(envelope, payload);
      default:
        return {
          processed: false,
          action: "ignored",
          details: `Unsupported billing type: ${envelope.message_type}`,
        };
    }
  }

  private handleInvoiceIssue(
    envelope: Envelope,
    payload: InvoiceIssuePayload
  ): { processed: boolean; action: string; details: unknown } {
    const invoiceId = payload.meta.invoice_id;

    if (this.state.invoices[invoiceId]) {
      return {
        processed: true,
        action: "rejected_duplicate",
        details: `Invoice ${invoiceId} already exists`,
      };
    }

    const businessRuleResult = validateBusinessRules(payload);
    if (!businessRuleResult.valid) {
      this.state.invoices[invoiceId] = {
        state: "fix_requested",
        payload,
        lastMessageId: envelope.message_id,
        updatedAt: new Date().toISOString(),
      };
      this.audit("invoice.fix_requested", invoiceId, {
        issues: businessRuleResult.fixableIssues,
      });
      return {
        processed: true,
        action: "request_fix",
        details: businessRuleResult.fixableIssues,
      };
    }

    this.state.invoices[invoiceId] = {
      state: "validated",
      payload,
      lastMessageId: envelope.message_id,
      updatedAt: new Date().toISOString(),
    };
    this.audit("invoice.received_and_validated", invoiceId, {
      from: envelope.from,
      total: payload.data.total,
    });

    return {
      processed: true,
      action: "validated",
      details: {
        from: envelope.from,
        total: payload.data.total,
        currency: payload.meta.currency,
      },
    };
  }

  private handleStateUpdate(
    envelope: Envelope,
    payload: unknown
  ): { processed: boolean; action: string; details: unknown } {
    const invoiceId = this.getInvoiceId(payload);
    if (!invoiceId || !this.state.invoices[invoiceId]) {
      return { processed: true, action: "ignored", details: "Unknown invoice" };
    }

    const invoice = this.state.invoices[invoiceId];
    const trans = transition(invoice.state, envelope.message_type);
    if (!trans.ok) {
      return {
        processed: true,
        action: "ignored",
        details: trans.error,
      };
    }

    invoice.state = trans.nextState!;
    invoice.lastMessageId = envelope.message_id;
    invoice.updatedAt = new Date().toISOString();
    this.audit(envelope.message_type, invoiceId, { payload });

    return {
      processed: true,
      action: envelope.message_type,
      details: { newState: trans.nextState },
    };
  }

  private findIssuerAgent(invoiceId: string): AgentId | null {
    const entry = this.state.auditLog.find(
      (audit) =>
        audit.invoiceId === invoiceId &&
        audit.event === "invoice.received_and_validated"
    );
    return (entry?.details?.from as AgentId) ?? null;
  }

  private getInvoiceId(payload: unknown): string | undefined {
    const meta = (payload as { meta?: { invoice_id?: string } } | undefined)?.meta;
    return meta?.invoice_id;
  }

  private audit(event: string, invoiceId?: string, details: Record<string, unknown> = {}): void {
    this.state.auditLog.push({
      timestamp: new Date().toISOString(),
      event,
      invoiceId,
      details,
    });
  }

  private loadOrCreateState(): void {
    if (existsSync(this.stateFile)) {
      this.state = this.normalizeState(
        JSON.parse(readFileSync(this.stateFile, "utf8")) as Partial<BillingState>
      );
      return;
    }

    const migrated = this.loadLegacyState();
    if (migrated) {
      this.state = migrated;
      this.saveState();
      return;
    }

    this.state = { invoices: {}, auditLog: [] };
    this.saveState();
  }

  private loadLegacyState(): BillingState | null {
    const legacyStateFile = join(this.agent.getDataDir(), "agent-state.json");
    if (!existsSync(legacyStateFile)) {
      return null;
    }

    const raw = JSON.parse(readFileSync(legacyStateFile, "utf8")) as {
      invoices?: Record<string, BillingInvoiceRecord>;
      auditLog?: BillingAuditEntry[];
    };

    if (!raw.invoices && !raw.auditLog) {
      return null;
    }

    return this.normalizeState({
      invoices: raw.invoices,
      auditLog: raw.auditLog,
    });
  }

  private normalizeState(raw: Partial<BillingState>): BillingState {
    return {
      invoices: raw.invoices ?? {},
      auditLog: Array.isArray(raw.auditLog) ? raw.auditLog : [],
    };
  }

  private saveState(): void {
    mkdirSync(this.agent.getDataDir(), { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }
}
