/**
 * @kshema/encryption/decrypt — the decrypt half of the envelope scheme.
 *
 * DO NOT import this module from `apps/api`. It requires a private key to do
 * anything useful, and the API holds none. It is imported only by clients that
 * legitimately hold key material:
 *   - `decryptBlackBox` runs on an Observer device / in the browser
 *     `Web_Crypto_Vault` (holds the Observer RSA private key).
 *   - `decryptEmergencyDossier` runs inside the responder edge route, which is
 *     the sole holder of the escrowed circle emergency private key (R33
 *     break-glass boundary).
 *
 * Keeping decrypt in a separate module (not re-exported from `index.ts`) is what
 * enforces R8.6/R19.3 at the package boundary: importing `@kshema/encryption`
 * gives you encrypt/store only.
 */
import type { KeyLike } from "node:crypto";
import {
  DecryptionIntegrityError,
  aesGcmDecrypt,
  deserializePayload,
  rsaOaepUnwrap,
} from "./envelope.js";
import type {
  EncryptedBlackBoxRecord,
  EncryptedDossierRecord,
} from "./types.js";

export { DecryptionIntegrityError } from "./envelope.js";

/** Raised when no recipient-key row matches the requesting Observer. */
export class NoRecipientKeyError extends Error {
  constructor(observerId: string) {
    super(`no wrapped key for observerId ${observerId}`);
    this.name = "NoRecipientKeyError";
  }
}

/**
 * Decrypt a released black box on the Observer's device (R8.9, R9.2).
 *
 * Selects the `BlackBoxRecipientKey` row whose `observerId` matches the
 * requesting Observer, RSA-OAEP-unwraps that row's `wrappedKey` into the
 * symmetric key with the Observer's private key, then AES-256-GCM-decrypts and
 * inflates the payload. A GCM tag mismatch (tamper) raises
 * {@link DecryptionIntegrityError}; a missing recipient row raises
 * {@link NoRecipientKeyError}.
 *
 * @typeParam T  The shape of the original rolling buffer, for the caller's
 *               convenience. The bytes are validated by GCM before parsing.
 */
export function decryptBlackBox<T = unknown>(
  record: EncryptedBlackBoxRecord,
  observerId: string,
  privateKey: string | KeyLike,
): T {
  const row = record.recipientKeys.find((r) => r.observerId === observerId);
  if (!row) {
    throw new NoRecipientKeyError(observerId);
  }

  let symKey: Buffer;
  try {
    symKey = rsaOaepUnwrap(privateKey as KeyLike, row.wrappedKey);
  } catch (cause) {
    // A wrong/tampered wrapped key or mismatched private key fails OAEP; treat
    // it as an integrity failure so no distinguishable error leaks.
    throw new DecryptionIntegrityError("failed to unwrap symmetric key", {
      cause,
    });
  }

  const plaintext = aesGcmDecrypt(
    symKey,
    record.iv,
    record.encryptedPayload,
    record.authTag,
  );
  return deserializePayload<T>(plaintext);
}

/**
 * Break-glass decrypt of an Emergency Medical Dossier using the escrowed circle
 * emergency private key (R33.3). Intended to run server-side inside the
 * responder edge route, gated by a valid `Emergency_Access_Token` and a bound
 * Stage-4 incident. The gating is enforced by the caller, not here.
 */
export function decryptEmergencyDossier<T = unknown>(
  record: EncryptedDossierRecord,
  emergencyPrivateKey: string | KeyLike,
): T {
  let symKey: Buffer;
  try {
    symKey = rsaOaepUnwrap(
      emergencyPrivateKey as KeyLike,
      record.encryptedEmergencyKey,
    );
  } catch (cause) {
    throw new DecryptionIntegrityError("failed to unwrap emergency symmetric key", {
      cause,
    });
  }

  const plaintext = aesGcmDecrypt(
    symKey,
    record.iv,
    record.encryptedPayload,
    record.authTag,
  );
  return deserializePayload<T>(plaintext);
}
