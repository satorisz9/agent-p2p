import { ed25519 } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2';

// Configure @noble/ed25519 to use @noble/hashes (no Node.js crypto needed)
ed25519.etc.sha512Sync = (...msgs: Uint8Array[]) => {
  const merged = new Uint8Array(msgs.reduce((a, m) => a + m.length, 0));
  let offset = 0;
  for (const m of msgs) { merged.set(m, offset); offset += m.length; }
  return sha512(merged);
};

function canonicalJson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export function verifyAgentId(agentId: string): boolean {
  return /^agent:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(agentId);
}

export function verifySignedRequest(
  body: Record<string, unknown>,
  publicKey: string
): boolean {
  const signature = body.signature as string;
  if (!signature) return false;

  // Check timestamp is within 5 minutes
  const timestamp = body.timestamp as string;
  if (!timestamp) return false;
  const diff = Math.abs(Date.now() - new Date(timestamp).getTime());
  if (diff > 5 * 60 * 1000) return false;

  // Build signing input (all fields except signature)
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k !== 'signature') fields[k] = v;
  }
  const signingInput = new TextEncoder().encode(canonicalJson(fields));

  try {
    return ed25519.verify(fromBase64(signature), signingInput, fromBase64(publicKey));
  } catch {
    return false;
  }
}
