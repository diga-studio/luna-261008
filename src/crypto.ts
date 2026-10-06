/** AES-256-GCM 加解密与哈希原语。 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

export interface Ciphertext {
  nonce: Buffer;
  data: Buffer;
  tag: Buffer;
}

export function sha256(...parts: Buffer[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

export function randomNonce(): Buffer {
  return randomBytes(NONCE_BYTES);
}

export function encrypt(key: Buffer, aad: Buffer, plaintext: Buffer, nonce: Buffer): Ciphertext {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, data, tag: cipher.getAuthTag() };
}

export function decrypt(key: Buffer, aad: Buffer, ciphertext: Ciphertext): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, ciphertext.nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(ciphertext.tag);
  return Buffer.concat([decipher.update(ciphertext.data), decipher.final()]);
}
