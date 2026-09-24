/**
 * @kshema/types — black-box sync DTOs (R8, R9).
 *
 * The API stores ciphertext verbatim and performs no decryption (R8.6,
 * R19.3). The server holds no private key; only fan-out-wrapped symmetric
 * keys (one per authorized Observer) transit.
 */
import { z } from "zod";
import { Base64, Id, IsoDateTime } from "./common.js";

/** One RSA-OAEP-wrapped copy of the payload key for a single Observer. */
export const RecipientKeySchema = z
  .object({
    observerId: Id,
    wrappedKey: Base64,
  })
  .strict();
export type RecipientKey = z.infer<typeof RecipientKeySchema>;

export const CapturedRangeSchema = z
  .object({
    start: IsoDateTime,
    end: IsoDateTime,
  })
  .strict();
export type CapturedRange = z.infer<typeof CapturedRangeSchema>;

export const BlackBoxSyncSchema = z
  .object({
    circleId: Id,
    encryptedPayload: Base64,
    iv: Base64,
    authTag: Base64,
    recipientKeys: z.array(RecipientKeySchema).min(1),
    capturedRange: CapturedRangeSchema,
  })
  .strict();
export type BlackBoxSync = z.infer<typeof BlackBoxSyncSchema>;

export const BlackBoxSyncResponseSchema = z
  .object({
    boxId: Id,
    storedRecipients: z.number().int().min(1),
  })
  .strict();
export type BlackBoxSyncResponse = z.infer<typeof BlackBoxSyncResponseSchema>;

/**
 * Released black-box fetch response. The API returns ciphertext only —
 * decryption happens on the Observer's device / in the Web_Crypto_Vault.
 */
export const BlackBoxCiphertextSchema = z
  .object({
    boxId: Id,
    encryptedPayload: Base64,
    iv: Base64,
    authTag: Base64,
    wrappedKey: Base64,
    capturedRange: CapturedRangeSchema,
  })
  .strict();
export type BlackBoxCiphertext = z.infer<typeof BlackBoxCiphertextSchema>;
