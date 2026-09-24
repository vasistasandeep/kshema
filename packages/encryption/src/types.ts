/**
 * @kshema/encryption — shared envelope-crypto types.
 *
 * These types mirror the `EncryptedBlackBox` + `BlackBoxRecipientKey` and
 * `EmergencyMedicalDossier` Prisma models (see
 * `packages/database/prisma/schema.prisma`). Byte fields are carried as
 * `Buffer` here and persisted as Prisma `Bytes` unchanged.
 */

/** One RSA-OAEP-wrapped copy of the payload symmetric key for a single Observer. */
export interface RecipientKey {
  /** CircleMember id of the black-box-authorized Observer. */
  readonly observerId: string;
  /** RSA-OAEP(SHA-256)-wrapped 256-bit AES key for this Observer. */
  readonly wrappedKey: Buffer;
}

/** An authorized Observer public key that a payload symmetric key is fanned out to. */
export interface ObserverPublicKey {
  readonly observerId: string;
  /** PEM-encoded RSA public key (SPKI / `-----BEGIN PUBLIC KEY-----`). */
  readonly publicKey: string;
}

/**
 * Server-blind envelope record produced by {@link encryptBlackBox}. Field names
 * align 1:1 with the `EncryptedBlackBox` columns plus the fan-out
 * `BlackBoxRecipientKey` rows. The server persists this verbatim and holds no
 * capability to decrypt it.
 */
export interface EncryptedBlackBoxRecord {
  /** AES-256-GCM ciphertext of gzip(JSON(payload)). */
  readonly encryptedPayload: Buffer;
  /** 96-bit GCM nonce. */
  readonly iv: Buffer;
  /** GCM authentication tag. */
  readonly authTag: Buffer;
  /** One wrapped symmetric-key copy per authorized Observer (fan-out wrap). */
  readonly recipientKeys: readonly RecipientKey[];
}

/**
 * Emergency-dossier envelope record. Mirrors the `EmergencyMedicalDossier`
 * ciphertext columns. Unlike the black box, the symmetric key is wrapped to a
 * single escrowed circle emergency key (the deliberate break-glass boundary,
 * R33) rather than fanned out to Observer keys.
 */
export interface EncryptedDossierRecord {
  /** AES-256-GCM ciphertext of gzip(JSON(dossier)). */
  readonly encryptedPayload: Buffer;
  /** 96-bit GCM nonce. */
  readonly iv: Buffer;
  /** GCM authentication tag. */
  readonly authTag: Buffer;
  /** Symmetric key wrapped to the circle emergency public key. */
  readonly encryptedEmergencyKey: Buffer;
}
