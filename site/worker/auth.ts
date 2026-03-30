import { hashes, verify } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

// Configure @noble/ed25519 to use @noble/hashes (no Node.js crypto needed)
hashes.sha512 = sha512;

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
    return verify(fromBase64(signature), signingInput, fromBase64(publicKey));
  } catch {
    return false;
  }
}
