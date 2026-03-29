/**
 * Private Key Encryption — AES-256-GCM with PBKDF2 key derivation.
 *
 * Encrypts the Ed25519 private key at rest in agent-state.json.
 * If no passphrase is provided, falls back to plaintext with a warning.
 */

import { pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv } from "crypto";

export interface EncryptedKey {
  encrypted: string; // base64
  salt: string;      // base64
  iv: string;        // base64
  tag: string;       // base64
}

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 32;
const IV_LENGTH = 12; // 96 bits for GCM

/**
 * Encrypt a base64-encoded private key using AES-256-GCM.
 * Key is derived from the passphrase via PBKDF2.
 */
export function encryptPrivateKey(privateKeyB64: string, passphrase: string): EncryptedKey {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha512");
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, derivedKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(privateKeyB64, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    encrypted: encrypted.toString("base64"),
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * Decrypt an encrypted private key back to its base64 representation.
 */
export function decryptPrivateKey(encryptedKey: EncryptedKey, passphrase: string): string {
  const salt = Buffer.from(encryptedKey.salt, "base64");
  const iv = Buffer.from(encryptedKey.iv, "base64");
  const tag = Buffer.from(encryptedKey.tag, "base64");
  const encrypted = Buffer.from(encryptedKey.encrypted, "base64");

  const derivedKey = pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha512");

  const decipher = createDecipheriv(ALGORITHM, derivedKey, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Get the encryption passphrase from environment or CLI args.
 * Returns null if not set (plaintext fallback).
 */
export function getPassphrase(): string | null {
  // Check env var first
  if (process.env.AGENT_P2P_PASSPHRASE) {
    return process.env.AGENT_P2P_PASSPHRASE;
  }

  // Check CLI args
  const args = process.argv.slice(2);
  const idx = args.indexOf("--passphrase");
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }

  return null;
}
