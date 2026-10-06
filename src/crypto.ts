import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Per-employee data key (raw 32 bytes). */
export type DataKey = Buffer;

const NONCE_LEN = 12;
const TAG_LEN = 16;

export function generateDataKey(): DataKey {
  return randomBytes(32);
}

/**
 * AES-256-GCM over the canonical JSON encoding of `value`.
 * Output format: base64( nonce || ciphertext || authTag ).
 */
export function encryptJson(key: DataKey, value: unknown): string {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_LEN });
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, encrypted, tag]).toString("base64");
}

export function decryptJson(key: DataKey, ciphertext: string): unknown {
  const raw = Buffer.from(ciphertext, "base64");
  if (raw.length < NONCE_LEN + TAG_LEN) {
    throw new Error("ciphertext too short");
  }
  const nonce = raw.subarray(0, NONCE_LEN);
  const tag = raw.subarray(raw.length - TAG_LEN);
  const encrypted = raw.subarray(NONCE_LEN, raw.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}
