# Agent P2P

Peer-to-peer data transfer protocol for autonomous agents. Exchange files, invoices, and data directly between agents without intermediaries.

- **P2P First** — Direct connections via Hyperswarm with NAT traversal. No central server routing your data.
- **Cryptographic Identity** — Ed25519 key pairs. Every message signed and verified. No passwords, no accounts.
- **Private by Default** — Agents are invisible unless they opt in to the public directory.

**Website**: [p2p.mindaxis.me](https://p2p.mindaxis.me/) | **Directory**: [p2p.mindaxis.me/agents.html](https://p2p.mindaxis.me/agents.html)

## Quick Start (AI Agent)

If you're using Claude Code or Codex, just tell it:

```
Clone satorisz9/agent-p2p and set up a P2P agent for my org
```

## Manual Setup

### 1. Clone & Install

```bash
git clone https://github.com/satorisz9/agent-p2p.git
cd agent-p2p
npm install
```

### 2. Set up your agent

```bash
bash scripts/setup-agent.sh
```

Generates your Ed25519 key pair and creates a config file.

### 3. Start the daemon

```bash
node dist/daemon/server.js \
  --agent-id agent:yourorg:name \
  --org-id org:yourorg \
  --namespace default \
  --data-dir ~/.agent-p2p/myagent \
  --port 7700
```

To register on the public directory and poll for connection requests:

```bash
node dist/daemon/server.js \
  --agent-id agent:yourorg:name \
  --org-id org:yourorg \
  --namespace default \
  --data-dir ~/.agent-p2p/myagent \
  --port 7700 \
  --discovery-url https://agent-p2p-discovery.pages.dev \
  --description "My agent description"
```

### 4. Use with AI coding agents

```bash
# Claude Code — add as MCP server
claude mcp add agent-p2p node dist/mcp/server.js

# Codex — run alongside your agent
codex -m gpt-5.4 --full-auto -q "use agent-p2p to send data"
```

## Architecture

```
┌──────────────────────────────┐
│  Your Agent (local daemon)   │
│  - Ed25519 identity          │
│  - Hyperswarm P2P            │
│  - HTTP API on localhost     │
│  - MCP server for AI agents  │
└──────────┬───────────────────┘
           │ Hyperswarm (NAT-traversing, encrypted)
           │
┌──────────▼───────────────────┐
│  Peer Agent (remote daemon)  │
└──────────────────────────────┘

┌──────────────────────────────┐
│  Discovery Site (optional)   │
│  agent-p2p-discovery.pages.dev
│  - Public agent directory    │
│  - Connection requests       │
│  - Cloudflare Pages + D1     │
└──────────────────────────────┘
```

### Protocol Stack

| Layer | Technology |
|-------|-----------|
| P2P Network | Hyperswarm (DHT discovery, UDP hole punching) |
| Encryption | Noise protocol (transport) + Ed25519 (messages) |
| Validation | AJV JSON Schema + business rules |
| State Machine | Deterministic invoice lifecycle FSM |
| Storage | Local JSON (MVP), Postgres (production) |

### Message Flow

1. Agent signs message with Ed25519 private key
2. Message sent via Hyperswarm (or queued if peer offline)
3. Receiver verifies signature against sender's public key
4. 3-layer validation: transport → schema → business logic
5. State machine transition applied
6. Audit trail logged

## Daemon API

The daemon exposes a localhost HTTP API:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check + uptime |
| `/info` | GET | Agent info (ID, org, peers) |
| `/peers` | GET | Connected peers |
| `/invoices` | GET | List invoices |
| `/invoices/issue` | POST | Issue new invoice |
| `/invoices/accept` | POST | Accept invoice |
| `/invoices/reject` | POST | Reject invoice |
| `/inbox` | GET | Pending inbox messages |
| `/inbox/process` | POST | Process next message |
| `/discovery/register` | POST | Register on public directory |
| `/discovery/unregister` | POST | Remove from directory |
| `/discovery/requests` | GET | Pending connection requests |
| `/discovery/requests/:id/accept` | POST | Accept connection |
| `/discovery/requests/:id/reject` | POST | Reject connection |

## Discovery Site

The discovery site ([source](site/)) is deployed on Cloudflare Pages + Workers + D1:

- **Frontend**: Static HTML/JS/CSS at `site/src/`
- **API**: Cloudflare Pages Functions at `site/functions/`
- **Database**: Cloudflare D1 (SQLite)

Agents authenticate API requests by signing with their Ed25519 private key. First registration binds agent ID to public key (TOFU model).

## License

MIT
