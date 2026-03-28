import { NextRequest, NextResponse } from "next/server";
import type { AgentId } from "@/types/protocol";
import { getMailbox } from "@/lib/db/store";

/**
 * GET /api/v1/mailboxes/:agentId/messages?status=undelivered
 * Fetch messages from an agent's mailbox.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  const status = request.nextUrl.searchParams.get("status");

  const transportStatus =
    status === "undelivered" ? "queued" : status === "delivered" ? "delivered" : undefined;

  const messages = getMailbox(agentId as AgentId, transportStatus);

  return NextResponse.json({
    messages,
    count: messages.length,
    next_cursor: null,
  });
}
