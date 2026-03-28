import type { InvoiceState, MessageType } from "@/types/protocol";

/**
 * Invoice state machine — deterministic transitions.
 * Key: current state
 * Value: map of message_type -> next state
 */
const TRANSITIONS: Record<
  InvoiceState,
  Partial<Record<MessageType, InvoiceState>>
> = {
  draft: {
    "invoice.issue": "issued",
  },
  issued: {
    "invoice.ack": "received",
    "invoice.reject": "rejected",
    "invoice.cancel": "cancelled",
  },
  received: {
    "invoice.ack": "parsed", // ack with processing_status=parsed
    "invoice.reject": "rejected",
  },
  parsed: {
    "invoice.accept": "accepted",
    "invoice.reject": "rejected",
    "invoice.request_fix": "fix_requested",
  },
  validated: {
    "invoice.accept": "accepted",
    "invoice.reject": "rejected",
    "invoice.request_fix": "fix_requested",
  },
  fix_requested: {
    "invoice.issue": "received", // reissue after fix
    "invoice.cancel": "cancelled",
  },
  accepted: {
    "payment.schedule": "scheduled_for_payment",
    "payment.notice": "paid",
  },
  scheduled_for_payment: {
    "payment.notice": "paid",
  },
  paid: {},
  rejected: {},
  cancelled: {},
};

export interface TransitionResult {
  ok: boolean;
  nextState?: InvoiceState;
  error?: string;
}

/**
 * Attempt a state transition. Returns the next state if valid.
 */
export function transition(
  currentState: InvoiceState,
  messageType: MessageType
): TransitionResult {
  const allowed = TRANSITIONS[currentState];
  if (!allowed) {
    return {
      ok: false,
      error: `Unknown state: ${currentState}`,
    };
  }

  const nextState = allowed[messageType];
  if (!nextState) {
    return {
      ok: false,
      error: `Transition not allowed: ${currentState} + ${messageType}`,
    };
  }

  return { ok: true, nextState };
}

/**
 * Check if a state is terminal (no further transitions possible).
 */
export function isTerminal(state: InvoiceState): boolean {
  return state === "paid" || state === "rejected" || state === "cancelled";
}
