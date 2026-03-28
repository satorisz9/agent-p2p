import {
  sign as edSign,
  verify as edVerify,
  getPublicKey,
  hashes,
} from "@noble/ed25519";
import { randomBytes, createHash } from "crypto";

// noble/ed25519 v3 requires hashes.sha512 to be set for sync operations
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(hashes as any).sha512 = (message: Uint8Array): Uint8Array => {
  return new Uint8Array(createHash("sha512").update(message).digest());
};

export interface KeyPair {
  privateKey: Uint8Array; // 32 bytes
  publicKey: Uint8Array; // 32 bytes
}

/** Generate a new Ed25519 key pair */
export function generateKeyPair(): KeyPair {
  const privateKey = new Uint8Array(randomBytes(32));
  const publicKey = getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/** Encode bytes to base64 */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Decode base64 to bytes */
export function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Sign a message (bytes) with Ed25519 private key */
export function sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return edSign(message, privateKey);
}

/** Verify an Ed25519 signature */
export function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): boolean {
  return edVerify(signature, message, publicKey);
}
