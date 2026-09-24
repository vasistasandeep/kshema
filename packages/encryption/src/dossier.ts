/**
 * @kshema/encryption — Emergency Medical Dossier envelope (encrypt side, R33).
 *
 * The dossier reuses the AES-256-GCM envelope but wraps its per-record
 * symmetric key to a single dedicated circle emergency key rather than fanning
 * out to Observer keys. This is the deliberate break-glass boundary described in
 * the design's "Two Cryptographic Boundaries" — distinct from the strict
 * zero-knowledge Flight Recorder. The emergency private key is escrowed on the
 * server so the responder edge route can unwrap it *only* within a valid
 * `Emergency_Access_Token` request; that server-side unwrap lives in
 * `decrypt.ts` and is not re-exported from the package entrypoint.
 */
import type { KeyLike } from "node:crypto";
import {
  aesGcmEncrypt,
  generateSymmetricKey,
  rsaOaepWrap,
  serializePayload,
} from "./envelope.js";
import type { EncryptedDossierRecord } from "./types.js";

/**
 * Serialize + compress an In-Case-of-Emergency dossier, AES-256-GCM encrypt it
 * under a fresh 256-bit key, and RSA-OAEP-wrap that key to the circle emergency
 * public key (R33.1). Produces a record aligned with the
 * `EmergencyMedicalDossier` ciphertext columns
 * (`encryptedPayload`, `iv`, `authTag`, `encryptedEmergencyKey`).
 *
 * @param dossier             Any JSON-able ICE payload (blood group, allergies,
 *                            chronic conditions, medications, physician,
 *                            insurance).
 * @param emergencyPublicKey  PEM-encoded circle emergency RSA public key.
 */
export function encryptEmergencyDossier(
  dossier: unknown,
  emergencyPublicKey: string,
): EncryptedDossierRecord {
  const plaintext = serializePayload(dossier);
  const symKey = generateSymmetricKey();
  const { ciphertext, iv, authTag } = aesGcmEncrypt(symKey, plaintext);
  const encryptedEmergencyKey = rsaOaepWrap(
    emergencyPublicKey as KeyLike,
    symKey,
  );
  return {
    encryptedPayload: ciphertext,
    iv,
    authTag,
    encryptedEmergencyKey,
  };
}
