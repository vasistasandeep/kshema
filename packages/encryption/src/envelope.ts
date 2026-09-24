/**
 * @kshema/encryption — low-level envelope primitives.
 *
 * Thin, dependency-free wrappers over Node's built-in `crypto` and `zlib` that
 * implement the envelope scheme from the design's "Zero-Knowledge Cryptography
 * Design" section:
 *
 *   plaintext = gzip(JSON.stringify(payload))
 *   symKey    = randomBytes(32)                 // 256-bit AES key, per payload
 *   iv        = randomBytes(12)                 // 96-bit GCM nonce
 *   {ct, tag} = AES-256-GCM(symKey, iv, plaintext)
 *   wrapped   = RSA-OAEP(SHA-256)(publicKey, symKey)
 *
 * Nothing here decides who may decrypt; that gating lives upstream. The
 * unwrap/decrypt half is intentionally isolated in `decrypt.ts` and is never
 * re-exported from the package entrypoint so `apps/api` cannot import it (R19.3).
 */
import {
  createCipheriv,
  createDecipheriv,
  publicEncrypt,
  privateDecrypt,
  randomBytes,
  constants as cryptoConstants,
  type KeyLike,
} from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

/** AES-256 key length in bytes (256-bit). */
export const SYMMETRIC_KEY_BYTES = 32;
/** GCM nonce length in bytes (96-bit, the AES-GCM recommended IV size). */
export const IV_BYTES = 12;
/** GCM authentication-tag length in bytes (128-bit). */
export const AUTH_TAG_BYTES = 16;

const AES_ALGORITHM = "aes-256-gcm";
const RSA_OAEP_OPTIONS = {
  padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
  oaepHash: "sha256",
} as const;

/**
 * Raised when authenticated-encryption integrity verification fails during
 * decryption (GCM tag mismatch, truncated ciphertext, wrong key, tamper). The
 * payload is rejected rather than returned (R9.2, Property 2).
 */
export class DecryptionIntegrityError extends Error {
  constructor(
    message = "Black-box payload failed integrity verification",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DecryptionIntegrityError";
  }
}

/** Serialize + compress an arbitrary JSON-able payload into gzipped bytes. */
export function serializePayload(payload: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
}

/** Inverse of {@link serializePayload}: gunzip then JSON.parse. */
export function deserializePayload<T = unknown>(plaintext: Buffer): T {
  return JSON.parse(gunzipSync(plaintext).toString("utf8")) as T;
}

/** Generate a fresh random 256-bit symmetric key. */
export function generateSymmetricKey(): Buffer {
  return randomBytes(SYMMETRIC_KEY_BYTES);
}

export interface AesGcmResult {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
}

/**
 * AES-256-GCM encrypt `plaintext` under `symKey`, generating a fresh 96-bit IV.
 */
export function aesGcmEncrypt(symKey: Buffer, plaintext: Buffer): AesGcmResult {
  if (symKey.length !== SYMMETRIC_KEY_BYTES) {
    throw new RangeError(
      `symmetric key must be ${SYMMETRIC_KEY_BYTES} bytes, got ${symKey.length}`,
    );
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_ALGORITHM, symKey, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

/**
 * AES-256-GCM decrypt. Throws {@link DecryptionIntegrityError} on any tag
 * mismatch or malformed input (never returns partial/unauthenticated bytes).
 */
export function aesGcmDecrypt(
  symKey: Buffer,
  iv: Buffer,
  ciphertext: Buffer,
  authTag: Buffer,
): Buffer {
  try {
    const decipher = createDecipheriv(AES_ALGORITHM, symKey, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (cause) {
    // Node throws "Unsupported state or unable to authenticate data" on tag
    // mismatch; normalize every failure to a single integrity error so callers
    // never distinguish tamper modes (and never see plaintext).
    throw new DecryptionIntegrityError(undefined, { cause });
  }
}

/** RSA-OAEP(SHA-256) wrap a symmetric key to a recipient public key. */
export function rsaOaepWrap(publicKey: KeyLike, symKey: Buffer): Buffer {
  return publicEncrypt({ key: publicKey, ...RSA_OAEP_OPTIONS }, symKey);
}

/** RSA-OAEP(SHA-256) unwrap a symmetric key with the recipient private key. */
export function rsaOaepUnwrap(privateKey: KeyLike, wrappedKey: Buffer): Buffer {
  return privateDecrypt({ key: privateKey, ...RSA_OAEP_OPTIONS }, wrappedKey);
}
