/**
 * Discovery Site Client — registers/unregisters agents and polls connection requests.
 */

import { sign, toBase64, fromBase64 } from "../crypto/keys";
import { canonicalJson } from "../crypto/signing";
import { randomUUID } from "crypto";

export interface DiscoveryConfig {
  discoveryUrl: string;
  agentId: string;
  orgId: string;
  publicKey: string;   // base64
  privateKey: string;  // base64
  capabilities?: string[];
  description?: string;
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

function signBody(body: Record<string, unknown>, privateKeyB64: string): Record<string, unknown> {
  const signingInput = new TextEncoder().encode(canonicalJson(body));
  const signature = sign(signingInput, fromBase64(privateKeyB64));
  return { ...body, signature: toBase64(signature) };
}

export class DiscoveryClient {
  private config: DiscoveryConfig;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private onRequest: ((req: ConnectionRequest) => void) | null = null;
  private seenRequestIds = new Set<string>();

  constructor(config: DiscoveryConfig) {
    this.config = config;
  }

  /** Register this agent as public on the discovery site */
  async register(): Promise<unknown> {
    const body = signBody({
      agent_id: this.config.agentId,
      org_id: this.config.orgId,
      public_key: this.config.publicKey,
      capabilities: this.config.capabilities || [],
      description: this.config.description || '',
      timestamp: new Date().toISOString(),
      nonce: randomUUID(),
    }, this.config.privateKey);

    const res = await fetch(`${this.config.discoveryUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  /** Remove this agent from the public directory */
  async unregister(): Promise<unknown> {
    const body = signBody({
      agent_id: this.config.agentId,
      timestamp: new Date().toISOString(),
      nonce: randomUUID(),
    }, this.config.privateKey);

    const res = await fetch(`${this.config.discoveryUrl}/api/register/${encodeURIComponent(this.config.agentId)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  /** Poll for pending connection requests */
  async pollRequests(): Promise<ConnectionRequest[]> {
    const body = signBody({
      agent_id: this.config.agentId,
      timestamp: new Date().toISOString(),
      nonce: randomUUID(),
    }, this.config.privateKey);

    const res = await fetch(`${this.config.discoveryUrl}/api/connect/${encodeURIComponent(this.config.agentId)}/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json() as { requests?: ConnectionRequest[] };
    return data.requests || [];
  }

  /** Accept or reject a connection request */
  async ackRequest(requestId: string, action: 'accept' | 'reject'): Promise<unknown> {
    const body = signBody({
      agent_id: this.config.agentId,
      action,
      timestamp: new Date().toISOString(),
      nonce: randomUUID(),
    }, this.config.privateKey);

    const res = await fetch(`${this.config.discoveryUrl}/api/connect/${requestId}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  /** Start polling for connection requests at the given interval */
  startPolling(intervalMs: number, callback: (req: ConnectionRequest) => void) {
    this.onRequest = callback;
    this.pollInterval = setInterval(async () => {
      try {
        const requests = await this.pollRequests();
        for (const req of requests) {
          if (!this.seenRequestIds.has(req.id)) {
            this.seenRequestIds.add(req.id);
            this.onRequest?.(req);
          }
        }
      } catch (err) {
        console.error(`[Discovery] Poll error: ${(err as Error).message}`);
      }
    }, intervalMs);
    console.error(`[Discovery] Polling every ${intervalMs / 1000}s for connection requests`);
  }

  /** Stop polling */
  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      console.error('[Discovery] Polling stopped');
    }
  }
}
