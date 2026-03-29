export interface Env {
  DB: D1Database;
}

export interface SignedRequest {
  agent_id: string;
  org_id?: string;
  public_key?: string;
  capabilities?: string[];
  description?: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

export interface PublicAgent {
  agent_id: string;
  org_id: string;
  public_key: string;
  capabilities: string;
  description: string | null;
  registered_at: string;
  updated_at: string;
}

export interface ConnectionRequest {
  id: string;
  target_agent_id: string;
  from_agent_id: string | null;
  from_name: string | null;
  from_contact: string | null;
  message: string | null;
  status: string;
  created_at: string;
  expires_at: string;
}
