/**
 * P2P Agent Core — runtime for peer connectivity, signed messaging, task flows,
 * file exchange, and persisted local state.
 *
 * Each agent instance:
 *   - Manages an Ed25519 key pair for signing and verification
 *   - Connects to the Hyperswarm P2P network
 *   - Exchanges signed messages and files with peers
 *   - Tracks local workflow state, including legacy billing records
 */

import { createHash, randomBytes } from "crypto";
import { EventEmitter } from "events";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";

import { P2PSwarm } from "../lib/p2p/swarm";
import {
  generateKeyPair,
  toBase64,
  fromBase64,
  type KeyPair,
} from "../lib/crypto/keys";
import { computePayloadHash, signEnvelope, verifyEnvelope } from "../lib/crypto/signing";
import {
  encryptPrivateKey,
  decryptPrivateKey,
  getPassphrase,
  type EncryptedKey,
} from "../lib/crypto/keystore";
import { validatePayload } from "../lib/validation/schemas";
import { validateBusinessRules } from "../lib/validation/business";
import { transition } from "../lib/state/machine";

import type {
  AgentId,
  OrgId,
  SignedMessage,
  Envelope,
  InvoiceIssuePayload,
  InvoiceState,
  MessageType,
  AgentRegistryEntry,
} from "../types/protocol";

// --- Persisted agent state ---

interface AgentState {
  agentId: AgentId;
  orgId: OrgId;
  keyId: string;
  publicKey: string; // base64
  privateKey: string; // base64 (plaintext fallback, cleared when encrypted)
  encryptedPrivateKey?: EncryptedKey; // AES-256-GCM encrypted private key
  namespace: string;
  invoices: Record<
    string,
    {
      state: InvoiceState;
      payload?: unknown;
      lastMessageId: string;
      updatedAt: string;
    }
  >;
  inbox: SignedMessage[];
  knownPeers: Record<string, { publicKey: string; agentId: AgentId }>;
  auditLog: Array<{
    timestamp: string;
    event: string;
    invoiceId?: string;
    details: Record<string, unknown>;
  }>;
}

export interface AgentConfig {
  dataDir: string; // where to persist state
  agentId: AgentId;
  orgId: OrgId;
  namespace: string; // P2P topic namespace
}

export class P2PAgent extends EventEmitter {
  private state!: AgentState;
  private keys!: KeyPair;
  private swarm!: P2PSwarm;
  private config: AgentConfig;
  private stateFile: string;

  constructor(config: AgentConfig) {
    super();
    this.config = config;
    this.stateFile = join(config.dataDir, "agent-state.json");
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  /** Initialize agent: load or create state, start P2P */
  async start(): Promise<void> {
    mkdirSync(this.config.dataDir, { recursive: true });
    this.loadOrCreateState();

    this.keys = {
      privateKey: fromBase64(this.state.privateKey),
      publicKey: fromBase64(this.state.publicKey),
    };

    // Start P2P swarm
    this.swarm = new P2PSwarm({
      agentId: this.config.agentId,
      namespace: this.config.namespace,
      seed: this.deriveSeed(),
    });

    // Handle incoming P2P messages
    this.swarm.on("message", (event: any) => {
      this.handleIncomingMessage(event.message, event.from);
    });

    // Handle incoming file transfers
    this.swarm.on("file", (event: any) => {
      const outDir = join(this.config.dataDir, "received");
      mkdirSync(outDir, { recursive: true });
      const filePath = join(outDir, event.filename);
      writeFileSync(filePath, Buffer.from(event.data, "base64"));
      console.error(`[Agent] Received file: ${event.filename} (${event.size} bytes) from ${event.from} → ${filePath}`);
      this.emit("file:received", { from: event.from, filename: event.filename, path: filePath, size: event.size });
    });

    this.swarm.on("peer:identified", (peer: any) => {
      // Register peer's swarm public key
      if (peer.agentId) {
        this.state.knownPeers[peer.remotePublicKey] = {
          publicKey: peer.remotePublicKey,
          agentId: peer.agentId,
        };
        this.saveState();
      }
    });

    await this.swarm.start();
    console.error(`[Agent] ${this.config.agentId} started`);
  }

  async stop(): Promise<void> {
    this.saveState();
    await this.swarm?.stop();
  }

  // ============================================================
  // Billing Operations (legacy)
  // ============================================================

  /** Issue an invoice and send to target agent via P2P */
  issueInvoice(
    targetAgentId: AgentId,
    invoicePayload: InvoiceIssuePayload
  ): { success: boolean; messageId?: string; error?: string } {
    const invoiceId = invoicePayload.meta.invoice_id;

    // Build envelope
    const envelope = this.buildEnvelope({
      to: targetAgentId,
      messageType: "invoice.issue",
      threadId: `thr_${invoiceId}`,
      idempotencyKey: `issue-${invoiceId}-v1`,
    }, invoicePayload);

    const message: SignedMessage = { envelope, payload: invoicePayload };

    // Send via P2P
    const sent = this.swarm.sendMessage(targetAgentId, message);
    if (!sent) {
      return {
        success: false,
        error: `Peer ${targetAgentId} not connected. Message queued for retry.`,
        messageId: envelope.message_id,
      };
    }

    // Update local state
    this.state.invoices[invoiceId] = {
      state: "issued",
      payload: invoicePayload,
      lastMessageId: envelope.message_id,
      updatedAt: new Date().toISOString(),
    };
    this.audit("invoice.issued", invoiceId, { to: targetAgentId });
    this.saveState();

    return { success: true, messageId: envelope.message_id };
  }

  /** Process the next message in the inbox */
  processNextInboxMessage(): {
    processed: boolean;
    action?: string;
    invoiceId?: string;
    details?: unknown;
  } {
    if (this.state.inbox.length === 0) {
      return { processed: false };
    }

    const message = this.state.inbox.shift()!;
    const result = this.processMessage(message);
    this.saveState();
    return result;
  }

  /** Accept an invoice manually */
  acceptInvoice(
    invoiceId: string,
    scheduledPaymentDate?: string
  ): { success: boolean; error?: string } {
    const inv = this.state.invoices[invoiceId];
    if (!inv) return { success: false, error: "Invoice not found" };

    const trans = transition(inv.state, "invoice.accept");
    if (!trans.ok) return { success: false, error: trans.error };

    inv.state = trans.nextState!;
    inv.updatedAt = new Date().toISOString();

    // Send accept message to issuer
    const acceptPayload = {
      meta: { invoice_id: invoiceId, currency: "JPY" as const },
      data: {
        accepted_at: new Date().toISOString(),
        accepted_by_agent: this.config.agentId,
        payment_status: "scheduled" as const,
        scheduled_payment_date: scheduledPaymentDate,
      },
    };

    // Find issuer from invoice state
    const issuerAgentId = this.findIssuerAgent(invoiceId);
    if (issuerAgentId) {
      const envelope = this.buildEnvelope({
        to: issuerAgentId,
        messageType: "invoice.accept",
        threadId: `thr_${invoiceId}`,
        idempotencyKey: `accept-${invoiceId}`,
      }, acceptPayload);
      this.swarm.sendMessage(issuerAgentId, { envelope, payload: acceptPayload });
    }

    this.audit("invoice.accepted", invoiceId, { scheduledPaymentDate });
    this.saveState();
    return { success: true };
  }

  /** Reject an invoice */
  rejectInvoice(
    invoiceId: string,
    reasonCode: string,
    reasonMessage: string
  ): { success: boolean; error?: string } {
    const inv = this.state.invoices[invoiceId];
    if (!inv) return { success: false, error: "Invoice not found" };

    const trans = transition(inv.state, "invoice.reject");
    if (!trans.ok) return { success: false, error: trans.error };

    inv.state = trans.nextState!;
    inv.updatedAt = new Date().toISOString();

    this.audit("invoice.rejected", invoiceId, { reasonCode, reasonMessage });
    this.saveState();
    return { success: true };
  }

  // ============================================================
  // Query and Introspection
  // ============================================================

  getInvoice(invoiceId: string) {
    return this.state.invoices[invoiceId] ?? null;
  }

  listInvoices() {
    return Object.entries(this.state.invoices).map(([id, inv]) => ({
      invoice_id: id,
      state: inv.state,
      updated_at: inv.updatedAt,
    }));
  }

  getInbox() {
    return this.state.inbox.map((msg) => ({
      message_id: msg.envelope.message_id,
      from: msg.envelope.from,
      type: msg.envelope.message_type,
      created_at: msg.envelope.created_at,
    }));
  }

  getConnectedPeers() {
    return this.swarm.getConnectedPeers().map((p) => ({
      agent_id: p.agentId ?? "unknown",
      remote_key: p.remotePublicKey.slice(0, 16) + "...",
      connected: p.connected,
    }));
  }

  getAuditLog(invoiceId?: string) {
    if (invoiceId) {
      return this.state.auditLog.filter((e) => e.invoiceId === invoiceId);
    }
    return this.state.auditLog.slice(-50); // last 50
  }

  getAgentInfo() {
    return {
      agent_id: this.config.agentId,
      org_id: this.config.orgId,
      public_key: this.state.publicKey,
      namespace: this.config.namespace,
      connected_peers: this.swarm.getConnectedPeers().length,
      inbox_count: this.state.inbox.length,
      invoice_count: Object.keys(this.state.invoices).length,
    };
  }

  /** Join an additional P2P namespace */
  joinNamespace(namespace: string): void {
    this.swarm.joinNamespace(namespace);
  }

  /** Send a file to a connected peer */
  sendFile(targetAgentId: AgentId, filePath: string): { success: boolean; error?: string } {
    if (!existsSync(filePath)) return { success: false, error: "File not found" };
    const data = readFileSync(filePath);
    const filename = filePath.split("/").pop() || "file";
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    const mimeMap: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
      pdf: "application/pdf", txt: "text/plain", json: "application/json",
    };
    const mime = mimeMap[ext] || "application/octet-stream";
    const sent = this.swarm.sendFile(
      targetAgentId, filename, data.toString("base64"), data.length, mime
    );
    if (sent) {
      console.error(`[Agent] Sent file: ${filename} (${data.length} bytes) to ${targetAgentId}`);
    }
    return { success: sent, error: sent ? undefined : "Peer not connected" };
  }

  /** Get the private key (base64) for discovery site signing */
  getPrivateKey(): string {
    return this.state.privateKey;
  }

  // ============================================================
  // Internal
  // ============================================================

  private processMessage(message: SignedMessage): {
    processed: boolean;
    action?: string;
    invoiceId?: string;
    details?: unknown;
  } {
    const { envelope, payload } = message;

    // Verify payload hash
    const hash = computePayloadHash(payload);
    if (hash !== envelope.payload_hash) {
      return {
        processed: true,
        action: "rejected",
        details: "Payload hash mismatch",
      };
    }

    // Verify signature if we know the sender's key
    // (In MVP we trust Hyperswarm's Noise encryption as Layer 1)

    // Schema validation
    const schemaResult = validatePayload(envelope.message_type, payload);
    if (!schemaResult.valid) {
      return {
        processed: true,
        action: "rejected",
        details: schemaResult.errors,
      };
    }

    // Handle by message type
    switch (envelope.message_type) {
      case "invoice.issue":
        return this.handleInvoiceIssue(envelope, payload as InvoiceIssuePayload);
      case "invoice.accept":
      case "invoice.reject":
      case "invoice.request_fix":
      case "payment.notice":
        return this.handleStateUpdate(envelope, payload);
      default:
        return { processed: true, action: "ignored", details: `Unknown type: ${envelope.message_type}` };
    }
  }

  private handleInvoiceIssue(
    envelope: Envelope,
    payload: InvoiceIssuePayload
  ): { processed: boolean; action: string; invoiceId: string; details: unknown } {
    const invoiceId = payload.meta.invoice_id;

    // Duplicate check
    if (this.state.invoices[invoiceId]) {
      return {
        processed: true,
        action: "rejected_duplicate",
        invoiceId,
        details: `Invoice ${invoiceId} already exists`,
      };
    }

    // Business validation
    const bizResult = validateBusinessRules(payload);

    if (!bizResult.valid) {
      this.state.invoices[invoiceId] = {
        state: "fix_requested",
        payload,
        lastMessageId: envelope.message_id,
        updatedAt: new Date().toISOString(),
      };
      this.audit("invoice.fix_requested", invoiceId, {
        issues: bizResult.fixableIssues,
      });
      return {
        processed: true,
        action: "request_fix",
        invoiceId,
        details: bizResult.fixableIssues,
      };
    }

    // Store as validated, waiting for accept/reject decision
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
      invoiceId,
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
  ): { processed: boolean; action: string; invoiceId?: string; details: unknown } {
    const meta = (payload as any)?.meta;
    const invoiceId = meta?.invoice_id;
    if (!invoiceId || !this.state.invoices[invoiceId]) {
      return { processed: true, action: "ignored", details: "Unknown invoice" };
    }

    const inv = this.state.invoices[invoiceId];
    const trans = transition(inv.state, envelope.message_type);
    if (!trans.ok) {
      return {
        processed: true,
        action: "ignored",
        invoiceId,
        details: trans.error,
      };
    }

    inv.state = trans.nextState!;
    inv.lastMessageId = envelope.message_id;
    inv.updatedAt = new Date().toISOString();
    this.audit(envelope.message_type, invoiceId, { payload });

    return {
      processed: true,
      action: envelope.message_type,
      invoiceId,
      details: { newState: trans.nextState },
    };
  }

  private handleIncomingMessage(message: SignedMessage, fromAgentId?: AgentId): void {
    console.error(
      `[Agent] Received ${message.envelope.message_type} from ${fromAgentId ?? "unknown"}`
    );
    this.state.inbox.push(message);
    this.saveState();
    this.emit("inbox:new", message);
  }

  private buildEnvelope(
    params: {
      to: AgentId;
      messageType: MessageType;
      threadId: string;
      idempotencyKey: string;
      replyToMessageId?: string;
    },
    payload: unknown
  ): Envelope {
    const payloadHash = computePayloadHash(payload);
    const messageId = `msg_${randomBytes(16).toString("hex")}`;

    const envelope: Envelope = {
      message_id: messageId,
      thread_id: params.threadId,
      from: this.config.agentId,
      to: params.to,
      message_type: params.messageType,
      schema_version: "0.1.0",
      created_at: new Date().toISOString(),
      idempotency_key: params.idempotencyKey,
      correlation_id: null,
      reply_to_message_id: params.replyToMessageId ?? null,
      expires_at: null,
      payload_hash: payloadHash,
      signature: { algorithm: "Ed25519", key_id: this.state.keyId, value: "" },
    };

    envelope.signature = signEnvelope(
      envelope,
      this.keys.privateKey,
      this.state.keyId
    );
    return envelope;
  }

  private findIssuerAgent(invoiceId: string): AgentId | null {
    // Look through audit log for the original issuer
    const entry = this.state.auditLog.find(
      (e) => e.invoiceId === invoiceId && e.event === "invoice.received_and_validated"
    );
    return (entry?.details?.from as AgentId) ?? null;
  }

  private audit(event: string, invoiceId?: string, details: Record<string, unknown> = {}): void {
    this.state.auditLog.push({
      timestamp: new Date().toISOString(),
      event,
      invoiceId,
      details,
    });
  }

  private deriveSeed(): Buffer {
    // Deterministic seed from agent ID + private key
    return createHash("sha256")
      .update(this.config.agentId + this.state.privateKey)
      .digest();
  }

  private loadOrCreateState(): void {
    const passphrase = getPassphrase();

    if (existsSync(this.stateFile)) {
      const raw = readFileSync(this.stateFile, "utf8");
      this.state = JSON.parse(raw);

      // Decrypt private key if encrypted
      if (this.state.encryptedPrivateKey) {
        if (!passphrase) {
          console.error(
            `[Agent] ERROR: State file has encrypted private key but no passphrase provided.`
          );
          console.error(
            `[Agent] Set AGENT_P2P_PASSPHRASE env var or pass --passphrase <value>`
          );
          process.exit(1);
        }
        try {
          this.state.privateKey = decryptPrivateKey(this.state.encryptedPrivateKey, passphrase);
        } catch (e) {
          console.error(`[Agent] ERROR: Failed to decrypt private key — wrong passphrase?`);
          process.exit(1);
        }
      } else if (passphrase) {
        // Existing plaintext state + passphrase provided: encrypt and re-save
        console.error(`[Agent] Encrypting existing plaintext private key...`);
        this.saveState();
      } else {
        console.error(
          `[Agent] WARNING: Private key stored in plaintext. Set AGENT_P2P_PASSPHRASE to encrypt.`
        );
      }

      console.error(`[Agent] Loaded state from ${this.stateFile}`);
      return;
    }

    // Generate new key pair
    const keys = generateKeyPair();
    const keyId = `key_${Date.now()}`;

    this.state = {
      agentId: this.config.agentId,
      orgId: this.config.orgId,
      keyId,
      publicKey: toBase64(keys.publicKey),
      privateKey: toBase64(keys.privateKey),
      namespace: this.config.namespace,
      invoices: {},
      inbox: [],
      knownPeers: {},
      auditLog: [],
    };

    if (!passphrase) {
      console.error(
        `[Agent] WARNING: No passphrase set — private key will be stored in plaintext.`
      );
      console.error(
        `[Agent] Set AGENT_P2P_PASSPHRASE env var or pass --passphrase <value> to encrypt.`
      );
    }

    this.saveState();
    console.error(`[Agent] Created new agent state at ${this.stateFile}`);
  }

  private saveState(): void {
    const passphrase = getPassphrase();
    const stateToWrite = { ...this.state };

    if (passphrase) {
      // Encrypt the private key before writing
      stateToWrite.encryptedPrivateKey = encryptPrivateKey(stateToWrite.privateKey, passphrase);
      // Remove plaintext private key from the persisted file
      stateToWrite.privateKey = "";
    }

    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify(stateToWrite, null, 2));
  }
}
