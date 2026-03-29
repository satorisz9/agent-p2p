// ============================================================
// Agent P2P Invoice Protocol — Core Types
// ============================================================

// --- ID Types ---

export type AgentId = `agent:${string}:${string}`;
export type OrgId = `org:${string}`;

// --- Message Types ---

export type MessageType =
  | "invoice.issue"
  | "invoice.ack"
  | "invoice.reject"
  | "invoice.request_fix"
  | "invoice.accept"
  | "invoice.cancel"
  | "payment.schedule"
  | "payment.notice"
  | "system.error"
  | "system.ping";

// --- Signature ---

export type SignatureAlgorithm = "Ed25519";

export interface Signature {
  algorithm: SignatureAlgorithm;
  key_id: string;
  value: string; // base64
}

// --- Envelope ---

export interface Envelope {
  message_id: string;
  thread_id: string;
  from: AgentId;
  to: AgentId;
  message_type: MessageType;
  schema_version: string;
  created_at: string; // ISO 8601
  idempotency_key: string;
  correlation_id?: string | null;
  reply_to_message_id?: string | null;
  expires_at?: string | null;
  payload_hash: string; // sha256:hex
  signature: Signature;
}

// --- Signed Message ---

export interface SignedMessage<TPayload = unknown> {
  envelope: Envelope;
  payload: TPayload;
}

// --- Payload Meta ---

export interface PayloadMeta {
  invoice_id: string;
  currency: "JPY" | "USD" | "EUR";
}

export interface PayloadBase<TData> {
  meta: PayloadMeta;
  data: TData;
}

// --- Agent Registry ---

export interface AgentRegistryEntry {
  agent_id: AgentId;
  org_id: OrgId;
  public_key: string; // base64 encoded Ed25519 public key
  algorithm: SignatureAlgorithm;
  endpoint: string;
  capabilities: MessageType[];
  status: "active" | "suspended" | "revoked";
  policy_hash?: string;
  created_at: string;
}

// --- Invoice States ---

export type InvoiceState =
  | "draft"
  | "issued"
  | "received"
  | "parsed"
  | "validated"
  | "fix_requested"
  | "accepted"
  | "scheduled_for_payment"
  | "paid"
  | "rejected"
  | "cancelled";

// --- Seller / Buyer ---

export interface Party {
  org_id: OrgId;
  name: string;
  tax_id: string;
  address: string;
  email: string;
}

// --- Line Item ---

export interface LineItem {
  line_id: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  tax_rate: number;
  amount_excluding_tax: number;
  tax_amount: number;
  amount_including_tax: number;
}

// --- Attachment ---

export interface Attachment {
  attachment_id: string;
  kind: string;
  filename: string;
  mime_type: string;
  sha256: string;
  size_bytes: number;
  url: string;
}

// --- Payment Terms ---

export interface PaymentTerms {
  method: "bank_transfer" | "credit_card" | "other";
  bank_account_ref?: string;
  terms_text: string;
}

// ============================================================
// Payload Data Types
// ============================================================

// invoice.issue
export interface InvoiceIssueData {
  invoice_number: string;
  issue_date: string;
  due_date: string;
  seller: Party;
  buyer: Party;
  purchase_order_ref?: string | null;
  contract_ref?: string | null;
  line_items: LineItem[];
  subtotal: number;
  tax_total: number;
  total: number;
  payment_terms: PaymentTerms;
  attachments?: Attachment[];
  notes?: string;
}
export type InvoiceIssuePayload = PayloadBase<InvoiceIssueData>;

// invoice.ack
export interface InvoiceAckData {
  ack_type: "received" | "parsed";
  received_at: string;
  processing_status: "received" | "parsed" | "validating";
  message?: string;
}
export type InvoiceAckPayload = PayloadBase<InvoiceAckData>;

// invoice.reject
export type RejectReasonCode =
  | "invalid_signature"
  | "invalid_schema"
  | "unknown_sender"
  | "duplicate_invoice"
  | "unsupported_currency"
  | "expired_message"
  | "unauthorized_capability";

export interface InvoiceRejectData {
  reason_code: RejectReasonCode;
  reason_message: string;
  details?: Record<string, unknown>;
  rejected_at: string;
  retryable: boolean;
}
export type InvoiceRejectPayload = PayloadBase<InvoiceRejectData>;

// invoice.request_fix
export interface FixIssue {
  code: string;
  field: string;
  message: string;
}

export interface InvoiceRequestFixData {
  requested_at: string;
  issues: FixIssue[];
  suggested_action: string;
}
export type InvoiceRequestFixPayload = PayloadBase<InvoiceRequestFixData>;

// invoice.accept
export interface InvoiceAcceptData {
  accepted_at: string;
  accepted_by_agent: AgentId;
  payment_status: "scheduled" | "pending";
  scheduled_payment_date?: string;
  internal_reference?: string;
}
export type InvoiceAcceptPayload = PayloadBase<InvoiceAcceptData>;

// payment.notice
export interface PaymentNoticeData {
  paid_at: string;
  amount_paid: number;
  payment_method: string;
  payment_reference: string;
  settlement_status: "paid" | "partial" | "failed";
}
export type PaymentNoticePayload = PayloadBase<PaymentNoticeData>;

// system.error
export interface SystemErrorData {
  error_code: string;
  message: string;
  retryable: boolean;
  failed_stage?: string;
}
export type SystemErrorPayload = PayloadBase<SystemErrorData>;

// --- Relay Types ---

export interface RelayResponse {
  relay_message_id: string;
  status: "queued" | "delivered" | "failed";
  queued_at: string;
}

// --- Audit Event ---

export interface AuditEvent {
  event_id: string;
  invoice_id: string;
  event_type: string;
  actor_type: "agent" | "human" | "system";
  actor_id: string;
  source_message_id: string;
  timestamp: string;
  details: Record<string, unknown>;
}

// --- Policy ---

export interface PolicyRule {
  name: string;
  when: Record<string, unknown>;
  then: "accept" | "reject" | "request_fix" | "human_review";
}

export interface Policy {
  policy_id: string;
  rules: PolicyRule[];
}

// ============================================================
// P2P Task Protocol — OpenClaw-compatible
// ============================================================

// --- Peer Permission Model ---

export interface PeerPermissions {
  /** What this peer can request from us */
  can_request: PeerCapability[];
  /** What this peer can send to us */
  can_send: PeerCapability[];
  /** Operations that require explicit approval before execution */
  requires_approval: PeerCapability[];
}

export type PeerCapability =
  | "task"           // Request/send task execution
  | "file"           // Send/receive files
  | "invoice"        // Invoice operations
  | "heartbeat"      // Status heartbeats
  | "admin";         // Modify permissions, disconnect

export type ConnectionMode = "open" | "restricted" | "readonly";

/** Per-peer connection config stored locally */
export interface PeerConfig {
  agent_id: AgentId;
  mode: ConnectionMode;
  permissions: PeerPermissions;
  connected_at: string;
  shared_namespace?: string;
}

// --- Task Message Types ---

export type TaskMessageType =
  | "task_request"
  | "task_accept"
  | "task_reject"
  | "task_result"
  | "task_error"
  | "task_cancel"
  | "heartbeat";

export type TaskStatus =
  | "pending"
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskRequest {
  task_id: string;
  type: string;                    // e.g. "code_review", "run_tests", "generate", "transform"
  description: string;
  input: Record<string, unknown>;  // Task-specific input data
  timeout_ms?: number;             // Max execution time
  priority?: "low" | "normal" | "high";
}

export interface TaskAccept {
  task_id: string;
  estimated_duration_ms?: number;
}

export interface TaskReject {
  task_id: string;
  reason: string;
}

export interface TaskResult {
  task_id: string;
  status: "completed" | "failed";
  output?: Record<string, unknown>;
  error?: string;
  duration_ms: number;
}

export interface TaskError {
  task_id: string;
  error_code: string;
  message: string;
  retryable: boolean;
}

export interface TaskCancel {
  task_id: string;
  reason?: string;
}

export interface Heartbeat {
  agent_id: AgentId;
  status: "idle" | "busy" | "overloaded";
  capabilities: string[];          // What task types this agent can handle
  active_tasks: number;
  max_tasks: number;
  uptime_ms: number;
  timestamp: string;
}

// --- Default permission presets ---

export const PERMISSION_PRESETS: Record<ConnectionMode, PeerPermissions> = {
  /** Full access — trusted peers */
  open: {
    can_request: ["task", "file", "invoice", "heartbeat", "admin"],
    can_send: ["task", "file", "invoice", "heartbeat", "admin"],
    requires_approval: [],
  },
  /** Selective — tasks need approval, files allowed */
  restricted: {
    can_request: ["task", "file", "heartbeat"],
    can_send: ["task", "file", "heartbeat"],
    requires_approval: ["task"],
  },
  /** Read-only — can receive heartbeats and results, can't request */
  readonly: {
    can_request: ["heartbeat"],
    can_send: ["heartbeat"],
    requires_approval: [],
  },
};
