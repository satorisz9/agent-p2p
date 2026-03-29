import { verifyAgentId, verifySignedRequest } from './auth';
import type { Env, SignedRequest, PublicAgent, ConnectionRequest } from './types';

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

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const pathParts = pathname.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);
  if (pathParts.length !== patternParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// --- Route Handlers ---

async function handleRegister(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as SignedRequest;
  if (!body.agent_id || !verifyAgentId(body.agent_id)) {
    return error('Invalid agent_id format');
  }
  if (!body.public_key || !body.org_id) {
    return error('public_key and org_id are required');
  }

  // Check if agent already registered
  const existing = await env.DB.prepare(
    'SELECT public_key FROM public_agents WHERE agent_id = ?'
  ).bind(body.agent_id).first<{ public_key: string }>();

  const keyForVerify = existing ? existing.public_key : body.public_key;
  if (!verifySignedRequest(body as unknown as Record<string, unknown>, keyForVerify)) {
    return error('Invalid signature', 401);
  }

  const capabilities = JSON.stringify(body.capabilities || []);
  await env.DB.prepare(`
    INSERT INTO public_agents (agent_id, org_id, public_key, capabilities, description)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      org_id = excluded.org_id,
      capabilities = excluded.capabilities,
      description = excluded.description,
      updated_at = datetime('now')
  `).bind(body.agent_id, body.org_id, body.public_key, capabilities, body.description || null).run();

  const agent = await env.DB.prepare(
    'SELECT * FROM public_agents WHERE agent_id = ?'
  ).bind(body.agent_id).first<PublicAgent>();

  return json(agent, existing ? 200 : 201);
}

async function handleDeregister(agentId: string, req: Request, env: Env): Promise<Response> {
  const body = await req.json() as SignedRequest;

  const existing = await env.DB.prepare(
    'SELECT public_key FROM public_agents WHERE agent_id = ?'
  ).bind(agentId).first<{ public_key: string }>();

  if (!existing) return error('Agent not found', 404);
  if (!verifySignedRequest(body as unknown as Record<string, unknown>, existing.public_key)) {
    return error('Invalid signature', 401);
  }

  await env.DB.prepare('DELETE FROM public_agents WHERE agent_id = ?').bind(agentId).run();
  return json({ deleted: true });
}

async function handleListAgents(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams.get('q');
  const org = url.searchParams.get('org');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  let query = 'SELECT * FROM public_agents WHERE 1=1';
  const binds: string[] = [];

  if (q) {
    query += ' AND (agent_id LIKE ? OR description LIKE ?)';
    binds.push(`%${q}%`, `%${q}%`);
  }
  if (org) {
    query += ' AND org_id = ?';
    binds.push(org);
  }

  query += ' ORDER BY registered_at DESC LIMIT ? OFFSET ?';
  binds.push(String(limit), String(offset));

  const stmt = env.DB.prepare(query);
  const result = await stmt.bind(...binds).all<PublicAgent>();

  return json({ agents: result.results, meta: { limit, offset } });
}

async function handleGetAgent(agentId: string, env: Env): Promise<Response> {
  const agent = await env.DB.prepare(
    'SELECT * FROM public_agents WHERE agent_id = ?'
  ).bind(agentId).first<PublicAgent>();

  if (!agent) return error('Agent not found', 404);
  return json(agent);
}

async function handleConnect(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as {
    target_agent_id: string;
    from_agent_id?: string;
    from_name?: string;
    from_contact?: string;
    message?: string;
  };

  if (!body.target_agent_id) return error('target_agent_id is required');

  const target = await env.DB.prepare(
    'SELECT agent_id FROM public_agents WHERE agent_id = ?'
  ).bind(body.target_agent_id).first();

  if (!target) return error('Target agent not found', 404);

  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(`
    INSERT INTO connection_requests (id, target_agent_id, from_agent_id, from_name, from_contact, message, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    body.target_agent_id,
    body.from_agent_id || null,
    body.from_name || null,
    body.from_contact || null,
    body.message || null,
    expiresAt
  ).run();

  return json({ id, status: 'pending', expires_at: expiresAt }, 201);
}

async function handlePollRequests(agentId: string, req: Request, env: Env): Promise<Response> {
  const body = await req.json() as SignedRequest;

  const existing = await env.DB.prepare(
    'SELECT public_key FROM public_agents WHERE agent_id = ?'
  ).bind(agentId).first<{ public_key: string }>();

  if (!existing) return error('Agent not found', 404);
  if (!verifySignedRequest(body as unknown as Record<string, unknown>, existing.public_key)) {
    return error('Invalid signature', 401);
  }

  // Clean up expired requests
  await env.DB.prepare(
    "DELETE FROM connection_requests WHERE status = 'pending' AND expires_at < datetime('now')"
  ).run();

  const requests = await env.DB.prepare(
    "SELECT * FROM connection_requests WHERE target_agent_id = ? AND status = 'pending' ORDER BY created_at DESC"
  ).bind(agentId).all<ConnectionRequest>();

  return json({ requests: requests.results });
}

async function handleAckRequest(requestId: string, req: Request, env: Env): Promise<Response> {
  const body = await req.json() as SignedRequest & { action: 'accept' | 'reject' };

  if (!body.action || !['accept', 'reject'].includes(body.action)) {
    return error('action must be "accept" or "reject"');
  }

  const request = await env.DB.prepare(
    'SELECT * FROM connection_requests WHERE id = ?'
  ).bind(requestId).first<ConnectionRequest>();

  if (!request) return error('Request not found', 404);

  const agent = await env.DB.prepare(
    'SELECT public_key FROM public_agents WHERE agent_id = ?'
  ).bind(request.target_agent_id).first<{ public_key: string }>();

  if (!agent) return error('Agent not found', 404);
  if (!verifySignedRequest(body as unknown as Record<string, unknown>, agent.public_key)) {
    return error('Invalid signature', 401);
  }

  const newStatus = body.action === 'accept' ? 'accepted' : 'rejected';
  await env.DB.prepare(
    'UPDATE connection_requests SET status = ? WHERE id = ?'
  ).bind(newStatus, requestId).run();

  return json({ id: requestId, status: newStatus });
}

// --- Main Router ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
        return handleRegister(request, env);
      }

      // DELETE /api/register/:agentId
      let params = matchRoute(path, '/api/register/:agentId');
      if (method === 'DELETE' && params) {
        return handleDeregister(params.agentId, request, env);
      }

      // GET /api/agents
      if (method === 'GET' && path === '/api/agents') {
        return handleListAgents(request, env);
      }

      // GET /api/agents/:agentId
      params = matchRoute(path, '/api/agents/:agentId');
      if (method === 'GET' && params) {
        return handleGetAgent(params.agentId, env);
      }

      // POST /api/connect
      if (method === 'POST' && path === '/api/connect') {
        return handleConnect(request, env);
      }

      // GET /api/connect/:agentId (poll)
      params = matchRoute(path, '/api/connect/:agentId');
      if (method === 'GET' && params) {
        return handlePollRequests(params.agentId, request, env);
      }

      // POST /api/connect/:requestId/ack
      params = matchRoute(path, '/api/connect/:requestId/ack');
      if (method === 'POST' && params) {
        return handleAckRequest(params.requestId, request, env);
      }

      return error('Not found', 404);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Internal error';
      return error(msg, 500);
    }
  },
} satisfies ExportedHandler<Env>;
