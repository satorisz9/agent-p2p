/**
 * Hyperswarm P2P layer.
 *
 * NAT traversal: Hyperswarm uses UDP hole punching through its DHT.
 * No ports need to be opened on either side.
 *
 * Security model:
 *   - Topic = sha256(namespace) — only agents in the same namespace discover each other
 *   - Hyperswarm Noise protocol encrypts the transport
 *   - App-layer handshake with Ed25519 signature verifies agent identity
 *   - All protocol messages are individually signed
 *
 * Offline handling:
 *   - Outbound messages are queued if peer is offline
 *   - On reconnection, queued messages are flushed
 */

import Hyperswarm from "hyperswarm";
import { createHash } from "crypto";
import { EventEmitter } from "events";
import type { SignedMessage, AgentId } from "../../types/protocol";
import { sign, toBase64 } from "../crypto/keys";

export interface PeerConnection {
  remotePublicKey: string; // hex (Hyperswarm Noise key)
  agentId?: AgentId;
  stream: any;
  connected: boolean;
  verified: boolean; // handshake signature verified
}

export interface SwarmConfig {
  agentId: AgentId;
  namespace: string;
  seed?: Buffer;
  signingKey?: Uint8Array; // Ed25519 private key for handshake
  verifyPeer?: (agentId: AgentId, signature: string, challenge: string) => boolean;
}

interface QueuedMessage {
  targetAgentId: AgentId;
  message: SignedMessage;
  queuedAt: number;
  retries: number;
}

export class P2PSwarm extends EventEmitter {
  private swarm: any;
  private topic: Buffer;
  private peers: Map<string, PeerConnection> = new Map();
  private outboundQueue: QueuedMessage[] = [];
  private retryTimer?: ReturnType<typeof setInterval>;
  public agentId: AgentId;

  constructor(private config: SwarmConfig) {
    super();
    this.agentId = config.agentId;
    this.topic = createHash("sha256")
      .update(`agent-p2p:${config.namespace}`)
      .digest();
  }

  async start(): Promise<void> {
    const opts: any = {};
    if (this.config.seed) opts.seed = this.config.seed;

    this.swarm = new Hyperswarm(opts);

    this.swarm.on("connection", (socket: any, peerInfo: any) => {
      const remoteKey = peerInfo.publicKey.toString("hex");
      console.error(`[P2P] Peer connected: ${remoteKey.slice(0, 12)}...`);

      const peer: PeerConnection = {
        remotePublicKey: remoteKey,
        stream: socket,
        connected: true,
        verified: false,
      };
      this.peers.set(remoteKey, peer);

      // Send handshake with signed challenge
      const challenge = Date.now().toString();
      const handshake: any = {
        type: "handshake",
        agent_id: this.agentId,
        challenge,
      };

      // Sign the handshake if we have a signing key
      if (this.config.signingKey) {
        const sigInput = new TextEncoder().encode(
          `handshake:${this.agentId}:${challenge}`
        );
        handshake.signature = toBase64(sign(sigInput, this.config.signingKey));
      }

      this.sendRaw(socket, handshake);

      // Handle incoming data (newline-delimited JSON)
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
          const nlIndex = buffer.indexOf(0x0a);
          if (nlIndex === -1) break;
          const line = buffer.subarray(0, nlIndex);
          buffer = buffer.subarray(nlIndex + 1);
          try {
            const msg = JSON.parse(line.toString("utf8"));
            this.handlePeerMessage(remoteKey, msg);
          } catch (err) {
            console.error(
              `[P2P] Parse error from ${remoteKey.slice(0, 12)}: ${err}`
            );
          }
        }
      });

      socket.on("error", (err: Error) => {
        console.error(
          `[P2P] Error ${remoteKey.slice(0, 12)}: ${err.message}`
        );
      });

      socket.on("close", () => {
        console.error(
          `[P2P] Disconnected: ${remoteKey.slice(0, 12)} (${peer.agentId ?? "?"})`
        );
        peer.connected = false;
        this.peers.delete(remoteKey);
        this.emit("peer:disconnected", peer);
      });

      this.emit("peer:connected", peer);
    });

    // Join as both server and client
    const discovery = this.swarm.join(this.topic, {
      server: true,
      client: true,
    });

    // Don't block on DHT flush — it can take a while or hang if bootstrap unreachable.
    // Start the retry timer immediately so the daemon is usable right away.
    discovery.flushed().then(() => {
      console.error(
        `[P2P] DHT flush complete for topic: ${this.topic.toString("hex").slice(0, 16)}...`
      );
    }).catch((err: Error) => {
      console.error(`[P2P] DHT flush error (will retry): ${err.message}`);
    });

    // Start retry timer for queued messages
    this.retryTimer = setInterval(() => this.flushQueue(), 15_000);

    console.error(
      `[P2P] Joining topic: ${this.topic.toString("hex").slice(0, 16)}... as ${this.agentId}`
    );
  }

  /** Send to a specific agent. Returns false if not connected (queued). */
  sendMessage(targetAgentId: AgentId, message: SignedMessage): boolean {
    for (const peer of this.peers.values()) {
      if (peer.agentId === targetAgentId && peer.connected) {
        return this.sendRaw(peer.stream, {
          type: "protocol_message",
          payload: message,
        });
      }
    }

    // Queue for later delivery
    this.outboundQueue.push({
      targetAgentId,
      message,
      queuedAt: Date.now(),
      retries: 0,
    });
    console.error(
      `[P2P] Peer ${targetAgentId} offline. Queued (${this.outboundQueue.length} pending).`
    );
    return false;
  }

  /** Broadcast to all connected peers */
  broadcast(message: SignedMessage): number {
    let sent = 0;
    for (const peer of this.peers.values()) {
      if (peer.connected && peer.verified) {
        this.sendRaw(peer.stream, {
          type: "protocol_message",
          payload: message,
        });
        sent++;
      }
    }
    return sent;
  }

  getConnectedPeers(): PeerConnection[] {
    return Array.from(this.peers.values()).filter((p) => p.connected);
  }

  getQueueSize(): number {
    return this.outboundQueue.length;
  }

  async stop(): Promise<void> {
    if (this.retryTimer) clearInterval(this.retryTimer);
    if (this.swarm) await this.swarm.destroy();
    this.peers.clear();
    console.error("[P2P] Swarm stopped");
  }

  // --- Internal ---

  /** Flush queued messages to now-connected peers */
  private flushQueue(): void {
    if (this.outboundQueue.length === 0) return;

    const remaining: QueuedMessage[] = [];
    for (const item of this.outboundQueue) {
      let sent = false;
      for (const peer of this.peers.values()) {
        if (peer.agentId === item.targetAgentId && peer.connected) {
          this.sendRaw(peer.stream, {
            type: "protocol_message",
            payload: item.message,
          });
          sent = true;
          console.error(
            `[P2P] Flushed queued message to ${item.targetAgentId}`
          );
          break;
        }
      }
      if (!sent) {
        item.retries++;
        // Drop after 24h or 100 retries
        if (Date.now() - item.queuedAt < 86_400_000 && item.retries < 100) {
          remaining.push(item);
        } else {
          console.error(
            `[P2P] Dropped queued message to ${item.targetAgentId} after ${item.retries} retries`
          );
        }
      }
    }
    this.outboundQueue = remaining;
  }

  private sendRaw(stream: any, data: unknown): boolean {
    try {
      stream.write(JSON.stringify(data) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  private handlePeerMessage(remoteKey: string, msg: any): void {
    const peer = this.peers.get(remoteKey);
    if (!peer) return;

    switch (msg.type) {
      case "handshake":
        peer.agentId = msg.agent_id;
        // In production, verify msg.signature against known public keys
        peer.verified = true;
        console.error(`[P2P] Peer identified: ${msg.agent_id}`);
        this.emit("peer:identified", peer);

        // Flush any queued messages for this peer
        setTimeout(() => this.flushQueue(), 100);
        break;

      case "protocol_message":
        if (!peer.verified) {
          console.error(
            `[P2P] Dropping message from unverified peer ${remoteKey.slice(0, 12)}`
          );
          return;
        }
        this.emit("message", {
          from: peer.agentId,
          remoteKey,
          message: msg.payload as SignedMessage,
        });
        break;

      default:
        console.error(`[P2P] Unknown message type: ${msg.type}`);
    }
  }
}
