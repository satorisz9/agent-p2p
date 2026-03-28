import { NextRequest, NextResponse } from "next/server";
import { ackDelivery } from "@/lib/db/store";

/**
 * POST /api/v1/mailboxes/:agentId/ack — Acknowledge message delivery
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { relay_message_id, message_id } = body;

    const id = message_id || relay_message_id;
    if (!id) {
      return NextResponse.json(
        { error: "message_id or relay_message_id required" },
        { status: 400 }
      );
    }

    const success = ackDelivery(id);
    if (!success) {
      return NextResponse.json(
        { error: "Message not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ status: "delivered", message_id: id });
  } catch (err) {
    return NextResponse.json(
      { error: `Internal error: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
