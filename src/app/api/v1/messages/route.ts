import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import type { SignedMessage } from "@/types/protocol";
import { processIncomingMessage } from "@/lib/relay/processor";
import { getMessage } from "@/lib/db/store";

/**
 * POST /api/v1/messages — Send a message through the relay
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as SignedMessage;

    if (!body.envelope || !body.payload) {
      return NextResponse.json(
        { error: "Missing envelope or payload" },
        { status: 400 }
      );
    }

    const result = processIncomingMessage(body);

    if (result.accepted) {
      return NextResponse.json({
        relay_message_id: `rmsg_${uuidv4().replace(/-/g, "")}`,
        status: "queued",
        queued_at: new Date().toISOString(),
        response: result.responsePayload ?? null,
        response_type: result.responseType,
      });
    }

    return NextResponse.json(
      {
        relay_message_id: `rmsg_${uuidv4().replace(/-/g, "")}`,
        status: "rejected",
        error: result.error,
        response_type: result.responseType,
        response: result.responsePayload ?? null,
      },
      { status: 422 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: `Internal error: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}

/**
 * GET /api/v1/messages?message_id=xxx — Get a specific message
 */
export async function GET(request: NextRequest) {
  const messageId = request.nextUrl.searchParams.get("message_id");
  if (!messageId) {
    return NextResponse.json(
      { error: "message_id query parameter required" },
      { status: 400 }
    );
  }

  const msg = getMessage(messageId);
  if (!msg) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }

  return NextResponse.json(msg);
}
