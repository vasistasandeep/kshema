/**
 * Key_Recovery flow orchestration (R23).
 *
 * Composes the client-only Argon2id backup/restore primitives from
 * `@kshema/encryption` with the {@link PlatformKeyStore} and {@link SecureEnclave}:
 *
 *   provisionRecovery  — R23.1: derive-and-encrypt a private-key backup under a
 *                        user passphrase, then sync the *encrypted* backup to
 *                        the platform key store. Plaintext key never leaves the
 *                        device; the API is never involved.
 *   restoreIdentity    — R23.2: on a new device, pull the encrypted backup,
 *                        decrypt it locally with the passphrase, and re-seat the
 *                        private key into the Secure_Enclave — again without the
 *                        API ever seeing the private key.
 *
 * `RecoveryBackup` carries raw `Buffer`s; those are base64-encoded here so the
 * blob is a plain JSON string the platform key store can hold.
 */
import {
  createRecoveryBackup,
  restoreFromRecoveryBackup,
  type RecoveryBackup,
  type RecoveryKdfParams,
} from "@kshema/encryption";
import {
  ENCLAVE_KEYS,
  type SecureEnclave,
} from "./secure-enclave.js";
import { isPrivateKeyPem } from "./keygen.js";
import {
  RECOVERY_BACKUP_SLOT,
  type PlatformKeyStore,
} from "./platform-key-store.js";

/** JSON-safe (base64) shape of a {@link RecoveryBackup} for the key store. */
export interface SerializedRecoveryBackup {
  readonly v: 1;
  readonly salt: string;
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
  readonly kdf: RecoveryKdfParams;
}

/** Encode a binary {@link RecoveryBackup} into a JSON-safe base64 record. */
export function serializeRecoveryBackup(
  backup: RecoveryBackup,
): SerializedRecoveryBackup {
  return {
    v: 1,
    salt: backup.salt.toString("base64"),
    iv: backup.iv.toString("base64"),
    authTag: backup.authTag.toString("base64"),
    ciphertext: backup.ciphertext.toString("base64"),
    kdf: backup.kdf,
  };
}

/** Decode a JSON-safe base64 record back into a binary {@link RecoveryBackup}. */
export function deserializeRecoveryBackup(
  serialized: SerializedRecoveryBackup,
): RecoveryBackup {
  return {
    salt: Buffer.from(serialized.salt, "base64"),
    iv: Buffer.from(serialized.iv, "base64"),
    authTag: Buffer.from(serialized.authTag, "base64"),
    ciphertext: Buffer.from(serialized.ciphertext, "base64"),
    kdf: serialized.kdf,
  };
}

export interface RecoveryDeps {
  readonly enclave: SecureEnclave;
  readonly keyStore: PlatformKeyStore;
}

/** Raised when Key_Recovery cannot proceed because the private key is absent. */
export class MissingPrivateKeyError extends Error {
  constructor() {
    super("No private key present in the Secure_Enclave to back up");
    this.name = "MissingPrivateKeyError";
  }
}

/** Raised when the platform cloud key store is unavailable (drives R23.3). */
export class PlatformKeyStoreUnavailableError extends Error {
  constructor() {
    super(
      "Platform key store unavailable; a Circle admin must re-invite this Observer with a fresh key (R23.3)",
    );
    this.name = "PlatformKeyStoreUnavailableError";
  }
}

/** Raised when no recovery backup exists on the platform key store to restore. */
export class NoRecoveryBackupError extends Error {
  constructor() {
    super("No recovery backup found in the platform key store");
    this.name = "NoRecoveryBackupError";
  }
}

/**
 * R23.1 — Provision Key_Recovery: encrypt the enclave's private key under
 * `passphrase` (Argon2id) and sync the encrypted backup to the platform key
 * store. Returns the serialized backup that was stored. The private key is read
 * from the enclave, encrypted locally, and never transmitted to the API.
 */
export async function provisionRecovery(
  deps: RecoveryDeps,
  passphrase: string,
): Promise<SerializedRecoveryBackup> {
  if (!(await deps.keyStore.isAvailable())) {
    throw new PlatformKeyStoreUnavailableError();
  }
  const privateKeyPem = await deps.enclave.getItem(ENCLAVE_KEYS.privateKeyPem);
  if (!privateKeyPem || !isPrivateKeyPem(privateKeyPem)) {
    throw new MissingPrivateKeyError();
  }
  const backup = await createRecoveryBackup(privateKeyPem, passphrase);
  const serialized = serializeRecoveryBackup(backup);
  await deps.keyStore.write(RECOVERY_BACKUP_SLOT, JSON.stringify(serialized));
  return serialized;
}

/**
 * R23.2 — Restore identity on a new device: pull the encrypted backup from the
 * platform key store, decrypt it locally with `passphrase`, and seat the
 * private key back into the Secure_Enclave. If `publicKeyPem` is supplied it is
 * stored alongside for re-registration. Throws
 * {@link import("@kshema/encryption").DecryptionIntegrityError} on a wrong
 * passphrase or tampered backup. The private key is never sent to the API.
 */
export async function restoreIdentity(
  deps: RecoveryDeps,
  passphrase: string,
  publicKeyPem?: string,
): Promise<{ privateKeyPem: string }> {
  if (!(await deps.keyStore.isAvailable())) {
    throw new PlatformKeyStoreUnavailableError();
  }
  const raw = await deps.keyStore.read(RECOVERY_BACKUP_SLOT);
  if (!raw) {
    throw new NoRecoveryBackupError();
  }
  const serialized = JSON.parse(raw) as SerializedRecoveryBackup;
  const backup = deserializeRecoveryBackup(serialized);
  const privateKeyPem = await restoreFromRecoveryBackup(backup, passphrase);
  await deps.enclave.setItem(ENCLAVE_KEYS.privateKeyPem, privateKeyPem);
  if (publicKeyPem) {
    await deps.enclave.setItem(ENCLAVE_KEYS.publicKeyPem, publicKeyPem);
  }
  return { privateKeyPem };
}

/** Whether a recovery backup currently exists on the platform key store. */
export async function hasRecoveryBackup(
  deps: RecoveryDeps,
): Promise<boolean> {
  return (await deps.keyStore.read(RECOVERY_BACKUP_SLOT)) !== null;
}
