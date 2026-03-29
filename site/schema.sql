CREATE TABLE IF NOT EXISTS public_agents (
  agent_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connection_requests (
  id TEXT PRIMARY KEY,
  target_agent_id TEXT NOT NULL,
  from_agent_id TEXT,
  from_name TEXT,
  from_contact TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (target_agent_id) REFERENCES public_agents(agent_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conn_req_target ON connection_requests(target_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_public_agents_org ON public_agents(org_id);
