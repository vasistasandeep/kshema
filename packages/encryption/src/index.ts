/**
 * @kshema/encryption — zero-knowledge Flight Recorder envelope crypto.
 *
 * This entrypoint exports the ENCRYPT/STORE surface plus client-only key
 * recovery. It deliberately does NOT export any routine that can decrypt a
 * black-box payload: `decryptBlackBox` (and the escrowed-dossier unwrap) live in
 * the separate `@kshema/encryption/decrypt` module and are never re-exported
 * here. `apps/api` imports this entrypoint and therefore has no code path to
 * read Flight Recorder contents (R8.6, R19.3).
 *
 * Decrypt consumers (Observer mobile app, browser `Web_Crypto_Vault`, and the
 * escrow-only responder edge route) import `@kshema/encryption/decrypt`
 * explicitly.
 */
export const ENCRYPTION_PACKAGE = "@kshema/encryption" as const;

// --- Envelope primitives (encrypt side + shared error) ---
export {
  DecryptionIntegrityError,
  serializePayload,
  generateSymmetricKey,
  aesGcmEncrypt,
  rsaOaepWrap,
  SYMMETRIC_KEY_BYTES,
  IV_BYTES,
  AUTH_TAG_BYTES,
  type AesGcmResult,
} from "./envelope.js";

// --- Black-box fan-out encrypt (R8.5) ---
export { encryptBlackBox } from "./blackbox.js";

// --- Emergency dossier envelope (R33.1) ---
export { encryptEmergencyDossier } from "./dossier.js";

// --- Key recovery (R23) — client-only Argon2id backup/restore ---
export {
  deriveRecoveryKey,
  createRecoveryBackup,
  restoreFromRecoveryBackup,
  generateRecoverySalt,
  DEFAULT_RECOVERY_KDF_PARAMS,
  RECOVERY_SALT_BYTES,
  type RecoveryKdfParams,
  type RecoveryBackup,
} from "./recovery.js";

// --- Shared record shapes (align with Prisma models) ---
export type {
  EncryptedBlackBoxRecord,
  EncryptedDossierRecord,
  RecipientKey,
  ObserverPublicKey,
} from "./types.js";

// NOTE: decryptBlackBox / decryptEmergencyDossier are intentionally absent.
// Import them from "@kshema/encryption/decrypt" on clients that hold a private
// key. Never import that module from apps/api.
