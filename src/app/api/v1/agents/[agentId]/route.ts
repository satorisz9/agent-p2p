import { NextRequest, NextResponse } from "next/server";
import type { AgentRegistryEntry } from "@/types/protocol";
import { registerAgent, getAgent, listAgents } from "@/lib/db/store";

/**
 * GET /api/v1/agents/:agentId — Get agent registry entry
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

  if (agentId === "_all") {
    return NextResponse.json({ agents: listAgents() });
  }

  const agent = getAgent(agentId);
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  return NextResponse.json(agent);
}

/**
 * PUT /api/v1/agents/:agentId — Register or update an agent
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

  try {
    const body = (await request.json()) as AgentRegistryEntry;

    if (body.agent_id !== agentId) {
      return NextResponse.json(
        { error: "agent_id in body must match URL" },
        { status: 400 }
      );
    }

    registerAgent(body);
    return NextResponse.json({ status: "registered", agent_id: agentId });
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid body: ${(err as Error).message}` },
      { status: 400 }
    );
  }
}
