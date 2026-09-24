/**
 * @kshema/encryption — Flight Recorder black-box envelope (encrypt side).
 *
 * `encryptBlackBox` is the ONLY black-box routine exported from the package
 * entrypoint. It produces a server-blind {@link EncryptedBlackBoxRecord} that
 * the API persists verbatim. The matching `decryptBlackBox` lives in
 * `decrypt.ts` and is deliberately NOT re-exported here, so `apps/api` cannot
 * import a decrypt capability (R8.6, R19.3).
 */
import type { KeyLike } from "node:crypto";
import {
  aesGcmEncrypt,
  generateSymmetricKey,
  rsaOaepWrap,
  serializePayload,
} from "./envelope.js";
import type {
  EncryptedBlackBoxRecord,
  ObserverPublicKey,
  RecipientKey,
} from "./types.js";

/**
 * Serialize + compress `buffer`, AES-256-GCM encrypt it under a fresh random
 * 256-bit key, and RSA-OAEP fan-out-wrap that symmetric key once per authorized
 * Observer public key (R8.5).
 *
 * @param buffer            The rolling Flight Recorder buffer (any JSON-able
 *                          snapshot list). It is `gzip(JSON.stringify(...))`-ed
 *                          before encryption.
 * @param observerPublicKeys One `{ observerId, publicKey }` per black-box-
 *                          authorized Observer. Each yields one
 *                          `BlackBoxRecipientKey` row so each Observer can
 *                          independently unwrap on their own device.
 * @returns A record aligned with the `EncryptedBlackBox` +
 *          `BlackBoxRecipientKey` Prisma models. Contains no plaintext and no
 *          private-key material.
 */
export function encryptBlackBox(
  buffer: unknown,
  observerPublicKeys: readonly ObserverPublicKey[],
): EncryptedBlackBoxRecord {
  if (observerPublicKeys.length === 0) {
    throw new RangeError(
      "encryptBlackBox requires at least one authorized Observer public key",
    );
  }

  // Reject duplicate observerIds up front: the schema enforces a unique
  // (boxId, observerId) constraint, so a duplicate would fail on persist.
  const seen = new Set<string>();
  for (const { observerId } of observerPublicKeys) {
    if (seen.has(observerId)) {
      throw new RangeError(`duplicate observerId in fan-out list: ${observerId}`);
    }
    seen.add(observerId);
  }

  const plaintext = serializePayload(buffer);
  const symKey = generateSymmetricKey();
  const { ciphertext, iv, authTag } = aesGcmEncrypt(symKey, plaintext);

  const recipientKeys: RecipientKey[] = observerPublicKeys.map(
    ({ observerId, publicKey }) => ({
      observerId,
      wrappedKey: rsaOaepWrap(publicKey as KeyLike, symKey),
    }),
  );

  return { encryptedPayload: ciphertext, iv, authTag, recipientKeys };
}
