import { createCipheriv, createDecipheriv } from "node:crypto";
import { VaultTermError } from "./errors";

/** Result of an AES-256-GCM encryption. */
export interface SealedBox {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
}

/** Encrypt plaintext under key with the given nonce and AAD. */
export function encrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array
): SealedBox {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

/** Decrypt a SealedBox; throws VaultTermError(INTEGRITY_FAILURE) on auth failure. */
export function decrypt(
  key: Uint8Array,
  aad: Uint8Array,
  box: SealedBox
): Uint8Array {
  const decipher = createDecipheriv("aes-256-gcm", key, box.nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(box.tag);
  try {
    return Buffer.concat([decipher.update(box.ciphertext), decipher.final()]);
  } catch {
    throw new VaultTermError(
      "INTEGRITY_FAILURE",
      "authentication failed: log data was tampered with or key is wrong"
    );
  }
}
