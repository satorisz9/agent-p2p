/**
 * Invite Manager — OTP-based private connection.
 *
 * Flow:
 *   1. A creates invite → gets short code (e.g. "ap2p-7Xk9mQ")
 *   2. A shares code with B out-of-band
 *   3. B accepts invite with code → both join a temp Hyperswarm topic derived from the code
 *   4. Handshake on temp topic: B sends code, A verifies → exchange agent IDs + public keys
 *   5. Both add each other as known peers on their main namespace
 *   6. Temp topic is left
 */

import Hyperswarm from "hyperswarm";
import { createHash, randomBytes } from "crypto";
import { EventEmitter } from "events";
import type { AgentId } from "../../types/protocol";

export interface Invite {
  code: string;
  createdAt: number;
  expiresAt: number;
}

export interface InviteResult {
  success: boolean;
  peerAgentId?: string;
  sharedNamespace?: string;
  error?: string;
}

function deriveSharedNamespace(code: string, agentIdA: string, agentIdB: string): string {
  const sorted = [agentIdA, agentIdB].sort();
  return createHash("sha256")
    .update(`agent-p2p-ns:${code}:${sorted[0]}:${sorted[1]}`)
    .digest("hex")
    .slice(0, 32);
}

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let code = "";
  const bytes = randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return `ap2p-${code}`;
}

function topicFromCode(code: string): Buffer {
  return createHash("sha256").update(`agent-p2p-invite:${code}`).digest();
}

export class InviteManager extends EventEmitter {
  private agentId: AgentId;
  private pendingInvites = new Map<string, Invite>();
  private activeSwarms = new Map<string, any>();

  constructor(agentId: AgentId) {
    super();
    this.agentId = agentId;
  }

  /** Create an invite code. Joins temp topic and waits for acceptor. */
  async create(expiresInSec = 600): Promise<Invite> {
    const code = generateCode();
    const now = Date.now();
    const invite: Invite = {
      code,
      createdAt: now,
      expiresAt: now + expiresInSec * 1000,
    };

    this.pendingInvites.set(code, invite);

    // Join temp topic and wait for peer
    const topic = topicFromCode(code);
    const swarm = new Hyperswarm();
    this.activeSwarms.set(code, swarm);

    swarm.on("connection", (socket: any) => {
      socket.on("error", () => {}); // Suppress ECONNRESET on cleanup
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const nlIndex = buffer.indexOf(0x0a);
        if (nlIndex === -1) return;
        const line = buffer.subarray(0, nlIndex).toString("utf8");
        buffer = buffer.subarray(nlIndex + 1);

        try {
          const msg = JSON.parse(line);
          if (msg.type === "invite_accept" && msg.code === code) {
            // Verify invite is still valid
            const inv = this.pendingInvites.get(code);
            if (!inv || Date.now() > inv.expiresAt) {
              this.sendJson(socket, { type: "invite_result", success: false, error: "expired" });
              return;
            }

            // Derive shared namespace from invite code + both agent IDs
            const sharedNs = deriveSharedNamespace(code, this.agentId, msg.agent_id);

            // Send confirmation with our agent ID + shared namespace
            this.sendJson(socket, {
              type: "invite_result",
              success: true,
              agent_id: this.agentId,
              shared_namespace: sharedNs,
            });

            // Emit event with shared namespace
            this.emit("invite:accepted", {
              code,
              peerAgentId: msg.agent_id,
              sharedNamespace: sharedNs,
            });

            // Cleanup
            this.pendingInvites.delete(code);
            this.cleanup(code);
          }
        } catch {}
      });
    });

    swarm.join(topic, { server: true, client: true });
    await swarm.flush().catch(() => {});

    console.error(`[Invite] Created: ${code} (expires in ${expiresInSec}s)`);

    // Auto-expire
    setTimeout(() => {
      if (this.pendingInvites.has(code)) {
        console.error(`[Invite] Expired: ${code}`);
        this.pendingInvites.delete(code);
        this.cleanup(code);
      }
    }, expiresInSec * 1000);

    return invite;
  }

  /** Accept an invite code. Joins temp topic, sends code, waits for confirmation. */
  async accept(code: string, timeoutMs = 30_000): Promise<InviteResult> {
    return new Promise(async (resolve) => {
      const topic = topicFromCode(code);
      const swarm = new Hyperswarm();
      this.activeSwarms.set(`accept-${code}`, swarm);
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.cleanup(`accept-${code}`);
          resolve({ success: false, error: "timeout" });
        }
      }, timeoutMs);

      swarm.on("connection", (socket: any) => {
        socket.on("error", () => {}); // Suppress ECONNRESET on cleanup

        // Send our accept message
        this.sendJson(socket, {
          type: "invite_accept",
          code,
          agent_id: this.agentId,
        });

        let buffer = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          const nlIndex = buffer.indexOf(0x0a);
          if (nlIndex === -1) return;
          const line = buffer.subarray(0, nlIndex).toString("utf8");
          buffer = buffer.subarray(nlIndex + 1);

          try {
            const msg = JSON.parse(line);
            if (msg.type === "invite_result" && !resolved) {
              resolved = true;
              clearTimeout(timer);
              this.cleanup(`accept-${code}`);

              if (msg.success) {
                this.emit("invite:connected", {
                  code,
                  peerAgentId: msg.agent_id,
                  sharedNamespace: msg.shared_namespace,
                });
                resolve({ success: true, peerAgentId: msg.agent_id, sharedNamespace: msg.shared_namespace });
              } else {
                resolve({ success: false, error: msg.error });
              }
            }
          } catch {}
        });
      });

      swarm.join(topic, { server: true, client: true });
      await swarm.flush().catch(() => {});
    });
  }

  /** List active invites */
  listPending(): Invite[] {
    const now = Date.now();
    return Array.from(this.pendingInvites.values()).filter(i => i.expiresAt > now);
  }

  private sendJson(socket: any, data: unknown) {
    socket.write(JSON.stringify(data) + "\n");
  }

  private async cleanup(key: string) {
    const swarm = this.activeSwarms.get(key);
    if (swarm) {
      try { await swarm.destroy(); } catch {}
      this.activeSwarms.delete(key);
    }
  }

  async destroy() {
    for (const [key] of this.activeSwarms) {
      await this.cleanup(key);
    }
    this.pendingInvites.clear();
  }
}
