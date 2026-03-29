import { ed25519 } from '@noble/curves/ed25519.js';

interface Env { DB: D1Database; }

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function canonicalJson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function verifySignedRequest(body: Record<string, unknown>, publicKey: string): boolean {
  const signature = body.signature as string;
  const timestamp = body.timestamp as string;
  if (!signature || !timestamp) return false;
  if (Math.abs(Date.now() - new Date(timestamp).getTime()) > 5 * 60 * 1000) return false;

  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k !== 'signature') fields[k] = v;
  }

  try {
    return ed25519.verify(fromBase64(signature), new TextEncoder().encode(canonicalJson(fields)), fromBase64(publicKey));
  } catch {
    return false;
  }
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  try {
    // POST /api/register
    if (method === 'POST' && path === '/api/register') {
      const body = await request.json() as Record<string, unknown>;
      const agentId = body.agent_id as string;
      if (!agentId || !/^agent:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(agentId)) {
        return err('Invalid agent_id format');
      }
      if (!body.public_key || !body.org_id) return err('public_key and org_id required');

      const existing = await env.DB.prepare(
        'SELECT public_key FROM public_agents WHERE agent_id = ?'
      ).bind(agentId).first<{ public_key: string }>();

      const key = existing ? existing.public_key : body.public_key as string;
      if (!verifySignedRequest(body, key)) return err('Invalid signature', 401);

      const caps = JSON.stringify((body.capabilities as string[]) || []);
      await env.DB.prepare(`
        INSERT INTO public_agents (agent_id, org_id, public_key, capabilities, description)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          org_id = excluded.org_id, capabilities = excluded.capabilities,
          description = excluded.description, updated_at = datetime('now')
      `).bind(agentId, body.org_id, body.public_key, caps, body.description || null).run();

      const agent = await env.DB.prepare(
        'SELECT * FROM public_agents WHERE agent_id = ?'
      ).bind(agentId).first();

      return json(agent, existing ? 200 : 201);
    }

    // DELETE /api/register/:agentId
    const delMatch = path.match(/^\/api\/register\/(.+)$/);
    if (method === 'DELETE' && delMatch) {
      const agentId = decodeURIComponent(delMatch[1]);
      const body = await request.json() as Record<string, unknown>;
      const existing = await env.DB.prepare(
        'SELECT public_key FROM public_agents WHERE agent_id = ?'
      ).bind(agentId).first<{ public_key: string }>();
      if (!existing) return err('Agent not found', 404);
      if (!verifySignedRequest(body, existing.public_key)) return err('Invalid signature', 401);

      await env.DB.prepare('DELETE FROM public_agents WHERE agent_id = ?').bind(agentId).run();
      return json({ deleted: true });
    }

    // GET /api/agents
    if (method === 'GET' && path === '/api/agents') {
      const q = url.searchParams.get('q');
      const org = url.searchParams.get('org');
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
      const offset = parseInt(url.searchParams.get('offset') || '0');

      let query = 'SELECT * FROM public_agents WHERE 1=1';
      const binds: string[] = [];
      if (q) { query += ' AND (agent_id LIKE ? OR description LIKE ?)'; binds.push(`%${q}%`, `%${q}%`); }
      if (org) { query += ' AND org_id = ?'; binds.push(org); }
      query += ' ORDER BY registered_at DESC LIMIT ? OFFSET ?';
      binds.push(String(limit), String(offset));

      const result = await env.DB.prepare(query).bind(...binds).all();
      return json({ agents: result.results, meta: { limit, offset } });
    }

    // GET /api/agents/:agentId
    const agentMatch = path.match(/^\/api\/agents\/(.+)$/);
    if (method === 'GET' && agentMatch) {
      const agentId = decodeURIComponent(agentMatch[1]);
      const agent = await env.DB.prepare(
        'SELECT * FROM public_agents WHERE agent_id = ?'
      ).bind(agentId).first();
      if (!agent) return err('Agent not found', 404);
      return json(agent);
    }

    // POST /api/connect
    if (method === 'POST' && path === '/api/connect') {
      const body = await request.json() as Record<string, unknown>;
      const targetId = body.target_agent_id as string;
      const fromAgentId = body.from_agent_id as string;
      if (!targetId) return err('target_agent_id required');
      if (!fromAgentId) return err('from_agent_id required');
      if (!/^agent:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(fromAgentId)) return err('Invalid from_agent_id format');

      const target = await env.DB.prepare(
        'SELECT agent_id FROM public_agents WHERE agent_id = ?'
      ).bind(targetId).first();
      if (!target) return err('Target agent not found', 404);

      const id = crypto.randomUUID();
      const inviteCode = (body.invite_code as string) || null;
      if (!inviteCode) return err('invite_code required — generate one with POST /invite/create on your daemon');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h

      await env.DB.prepare(`
        INSERT INTO connection_requests (id, target_agent_id, from_agent_id, from_name, from_contact, message, invite_code, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id, targetId,
        fromAgentId,
        (body.from_name as string) || null,
        (body.from_contact as string) || null,
        (body.message as string) || null,
        inviteCode,
        expiresAt
      ).run();

      return json({ id, status: 'pending', invite_code: inviteCode, expires_at: expiresAt }, 201);
    }

    // POST /api/connect/:requestId/ack
    const ackMatch = path.match(/^\/api\/connect\/([^/]+)\/ack$/);
    if (method === 'POST' && ackMatch) {
      const requestId = ackMatch[1];
      const body = await request.json() as Record<string, unknown>;
      const action = body.action as string;
      if (!action || !['accept', 'reject'].includes(action)) return err('action must be accept or reject');

      const req = await env.DB.prepare(
        'SELECT * FROM connection_requests WHERE id = ?'
      ).bind(requestId).first<{ target_agent_id: string }>();
      if (!req) return err('Request not found', 404);

      const agent = await env.DB.prepare(
        'SELECT public_key FROM public_agents WHERE agent_id = ?'
      ).bind(req.target_agent_id).first<{ public_key: string }>();
      if (!agent) return err('Agent not found', 404);
      if (!verifySignedRequest(body, agent.public_key)) return err('Invalid signature', 401);

      await env.DB.prepare(
        'UPDATE connection_requests SET status = ? WHERE id = ?'
      ).bind(action === 'accept' ? 'accepted' : 'rejected', requestId).run();

      return json({ id: requestId, status: action === 'accept' ? 'accepted' : 'rejected' });
    }

    // POST /api/connect/:agentId/poll (poll for pending requests)
    const pollMatch = path.match(/^\/api\/connect\/([^/]+)\/poll$/);
    if (method === 'POST' && pollMatch) {
      const agentId = decodeURIComponent(pollMatch[1]);
      const body = await request.json() as Record<string, unknown>;

      const agent = await env.DB.prepare(
        'SELECT public_key FROM public_agents WHERE agent_id = ?'
      ).bind(agentId).first<{ public_key: string }>();
      if (!agent) return err('Agent not found', 404);
      if (!verifySignedRequest(body, agent.public_key)) return err('Invalid signature', 401);

      await env.DB.prepare(
        "DELETE FROM connection_requests WHERE status = 'pending' AND expires_at < datetime('now')"
      ).run();

      const requests = await env.DB.prepare(
        "SELECT * FROM connection_requests WHERE target_agent_id = ? AND status = 'pending' ORDER BY created_at DESC"
      ).bind(agentId).all();

      return json({ requests: requests.results });
    }

    return err('Not found', 404);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Internal error', 500);
  }
};
