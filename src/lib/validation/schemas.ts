import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { MessageType } from "../../types/protocol";

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

// --- invoice.issue schema ---
const invoiceIssueSchema = {
  $id: "invoice.issue",
  type: "object",
  required: ["meta", "data"],
  properties: {
    meta: {
      type: "object",
      required: ["invoice_id", "currency"],
      properties: {
        invoice_id: { type: "string", minLength: 1 },
        currency: { type: "string", enum: ["JPY", "USD", "EUR"] },
      },
    },
    data: {
      type: "object",
      required: [
        "invoice_number",
        "issue_date",
        "due_date",
        "seller",
        "buyer",
        "line_items",
        "subtotal",
        "tax_total",
        "total",
      ],
      properties: {
        invoice_number: { type: "string", minLength: 1 },
        issue_date: { type: "string", format: "date" },
        due_date: { type: "string", format: "date" },
        purchase_order_ref: { type: ["string", "null"] },
        contract_ref: { type: ["string", "null"] },
        seller: {
          type: "object",
          required: ["org_id", "name", "tax_id", "address", "email"],
          properties: {
            org_id: { type: "string" },
            name: { type: "string" },
            tax_id: { type: "string" },
            address: { type: "string" },
            email: { type: "string", format: "email" },
          },
        },
        buyer: {
          type: "object",
          required: ["org_id", "name", "tax_id", "address", "email"],
          properties: {
            org_id: { type: "string" },
            name: { type: "string" },
            tax_id: { type: "string" },
            address: { type: "string" },
            email: { type: "string", format: "email" },
          },
        },
        line_items: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: [
              "line_id",
              "description",
              "quantity",
              "unit_price",
              "tax_rate",
              "amount_excluding_tax",
              "tax_amount",
              "amount_including_tax",
            ],
            properties: {
              line_id: { type: "string" },
              description: { type: "string" },
              quantity: { type: "number", minimum: 0 },
              unit: { type: "string" },
              unit_price: { type: "number", minimum: 0 },
              tax_rate: { type: "number", minimum: 0, maximum: 1 },
              amount_excluding_tax: { type: "number", minimum: 0 },
              tax_amount: { type: "number", minimum: 0 },
              amount_including_tax: { type: "number", minimum: 0 },
            },
          },
        },
        subtotal: { type: "integer", minimum: 0 },
        tax_total: { type: "integer", minimum: 0 },
        total: { type: "integer", minimum: 0 },
        payment_terms: {
          type: "object",
          required: ["method", "terms_text"],
          properties: {
            method: {
              type: "string",
              enum: ["bank_transfer", "credit_card", "other"],
            },
            bank_account_ref: { type: "string" },
            terms_text: { type: "string" },
          },
        },
        attachments: {
          type: "array",
          items: {
            type: "object",
            required: [
              "attachment_id",
              "kind",
              "filename",
              "mime_type",
              "sha256",
              "size_bytes",
              "url",
            ],
          },
        },
        notes: { type: "string" },
      },
    },
  },
};

// --- invoice.ack schema ---
const invoiceAckSchema = {
  $id: "invoice.ack",
  type: "object",
  required: ["meta", "data"],
  properties: {
    meta: {
      type: "object",
      required: ["invoice_id", "currency"],
    },
    data: {
      type: "object",
      required: ["ack_type", "received_at", "processing_status"],
      properties: {
        ack_type: { type: "string", enum: ["received", "parsed"] },
        received_at: { type: "string", format: "date-time" },
        processing_status: {
          type: "string",
          enum: ["received", "parsed", "validating"],
        },
        message: { type: "string" },
      },
    },
  },
};

// --- invoice.reject schema ---
const invoiceRejectSchema = {
  $id: "invoice.reject",
  type: "object",
  required: ["meta", "data"],
  properties: {
    meta: {
      type: "object",
      required: ["invoice_id", "currency"],
    },
    data: {
      type: "object",
      required: ["reason_code", "reason_message", "rejected_at", "retryable"],
      properties: {
        reason_code: {
          type: "string",
          enum: [
            "invalid_signature",
            "invalid_schema",
            "unknown_sender",
            "duplicate_invoice",
            "unsupported_currency",
            "expired_message",
            "unauthorized_capability",
          ],
        },
        reason_message: { type: "string" },
        details: { type: "object" },
        rejected_at: { type: "string", format: "date-time" },
        retryable: { type: "boolean" },
      },
    },
  },
};

// --- invoice.request_fix schema ---
const invoiceRequestFixSchema = {
  $id: "invoice.request_fix",
  type: "object",
  required: ["meta", "data"],
  properties: {
    meta: {
      type: "object",
      required: ["invoice_id", "currency"],
    },
    data: {
      type: "object",
      required: ["requested_at", "issues", "suggested_action"],
      properties: {
        requested_at: { type: "string", format: "date-time" },
        issues: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["code", "field", "message"],
          },
        },
        suggested_action: { type: "string" },
      },
    },
  },
};

// --- invoice.accept schema ---
const invoiceAcceptSchema = {
  $id: "invoice.accept",
  type: "object",
  required: ["meta", "data"],
  properties: {
    meta: {
      type: "object",
      required: ["invoice_id", "currency"],
    },
    data: {
      type: "object",
      required: ["accepted_at", "accepted_by_agent", "payment_status"],
      properties: {
        accepted_at: { type: "string", format: "date-time" },
        accepted_by_agent: { type: "string" },
        payment_status: { type: "string", enum: ["scheduled", "pending"] },
        scheduled_payment_date: { type: "string", format: "date" },
        internal_reference: { type: "string" },
      },
    },
  },
};

// --- payment.notice schema ---
const paymentNoticeSchema = {
  $id: "payment.notice",
  type: "object",
  required: ["meta", "data"],
  properties: {
    meta: {
      type: "object",
      required: ["invoice_id", "currency"],
    },
    data: {
      type: "object",
      required: [
        "paid_at",
        "amount_paid",
        "payment_method",
        "payment_reference",
        "settlement_status",
      ],
      properties: {
        paid_at: { type: "string", format: "date-time" },
        amount_paid: { type: "number", minimum: 0 },
        payment_method: { type: "string" },
        payment_reference: { type: "string" },
        settlement_status: {
          type: "string",
          enum: ["paid", "partial", "failed"],
        },
      },
    },
  },
};

// Register all schemas
const schemas: Record<string, object> = {
  "invoice.issue": invoiceIssueSchema,
  "invoice.ack": invoiceAckSchema,
  "invoice.reject": invoiceRejectSchema,
  "invoice.request_fix": invoiceRequestFixSchema,
  "invoice.accept": invoiceAcceptSchema,
  "payment.notice": paymentNoticeSchema,
};

for (const [, schema] of Object.entries(schemas)) {
  ajv.addSchema(schema);
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

/**
 * Validate a payload against its message type schema.
 */
export function validatePayload(
  messageType: MessageType,
  payload: unknown
): ValidationResult {
  const schemaId = messageType;
  const validate = ajv.getSchema(schemaId);

  if (!validate) {
    return {
      valid: false,
      errors: [`No schema registered for message type: ${messageType}`],
    };
  }

  const valid = validate(payload);
  if (valid) {
    return { valid: true };
  }

  return {
    valid: false,
    errors: validate.errors?.map(
      (e) => `${e.instancePath || "/"}: ${e.message}`
    ),
  };
}
