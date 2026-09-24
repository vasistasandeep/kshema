/**
 * @kshema/encryption — Key_Recovery helpers (R23).
 *
 * At identity setup the client derives a recovery key from a user recovery
 * passphrase with Argon2id and uses it to encrypt a backup of the RSA private
 * key. The encrypted backup is what is stored in the platform key store (iCloud
 * Keychain / Google Password Manager); the plaintext private key never reaches
 * the API. This module runs on the client (mobile/web) — it is not imported by
 * `apps/api`.
 *
 * Argon2id is provided by `hash-wasm` (pure WebAssembly, MIT-licensed), which
 * runs identically in Node, React Native (Hermes with WASM), and browsers, and
 * needs no native build step.
 */
import { argon2id } from "hash-wasm";
import { randomBytes } from "node:crypto";
import {
  AUTH_TAG_BYTES,
  IV_BYTES,
  SYMMETRIC_KEY_BYTES,
  aesGcmDecrypt,
  aesGcmEncrypt,
} from "./envelope.js";

/**
 * Argon2id cost parameters. Defaults follow OWASP's Argon2id guidance
 * (memory-hard, ~19 MiB, 2 passes, 1 lane) — strong enough for a recovery
 * passphrase while remaining feasible on a mobile device.
 */
export interface RecoveryKdfParams {
  /** Memory cost in KiB. */
  readonly memorySizeKiB: number;
  /** Number of iterations (time cost / passes). */
  readonly iterations: number;
  /** Degree of parallelism (lanes). */
  readonly parallelism: number;
  /** Derived key length in bytes. Defaults to a 256-bit AES key. */
  readonly keyLengthBytes: number;
}

export const DEFAULT_RECOVERY_KDF_PARAMS: RecoveryKdfParams = {
  memorySizeKiB: 19_456, // ~19 MiB
  iterations: 2,
  parallelism: 1,
  keyLengthBytes: SYMMETRIC_KEY_BYTES,
};

/** Recommended random salt length for the recovery passphrase (128-bit). */
export const RECOVERY_SALT_BYTES = 16;

/** Generate a fresh random salt for {@link deriveRecoveryKey}. */
export function generateRecoverySalt(): Buffer {
  return randomBytes(RECOVERY_SALT_BYTES);
}

/**
 * Derive a symmetric recovery key from a user recovery passphrase using
 * Argon2id (R23.1). The returned key is suitable as an AES-256 key for wrapping
 * the private-key backup. Deterministic for a given passphrase + salt + params.
 */
export async function deriveRecoveryKey(
  passphrase: string,
  salt: Buffer,
  params: RecoveryKdfParams = DEFAULT_RECOVERY_KDF_PARAMS,
): Promise<Buffer> {
  const hash = await argon2id({
    password: passphrase,
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memorySizeKiB,
    hashLength: params.keyLengthBytes,
    outputType: "binary",
  });
  return Buffer.from(hash);
}

/**
 * Self-describing encrypted backup of a private key. Everything except the
 * passphrase is safe to hand to the platform key store; without the passphrase
 * the backup is undecryptable.
 */
export interface RecoveryBackup {
  readonly salt: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly ciphertext: Buffer;
  readonly kdf: RecoveryKdfParams;
}

/**
 * Encrypt a private-key PEM under a passphrase-derived recovery key, producing a
 * {@link RecoveryBackup} for the platform key store (R23.1). The plaintext
 * private key is consumed locally and never returned in the backup.
 */
export async function createRecoveryBackup(
  privateKeyPem: string,
  passphrase: string,
  params: RecoveryKdfParams = DEFAULT_RECOVERY_KDF_PARAMS,
): Promise<RecoveryBackup> {
  const salt = generateRecoverySalt();
  const recoveryKey = await deriveRecoveryKey(passphrase, salt, params);
  const { ciphertext, iv, authTag } = aesGcmEncrypt(
    recoveryKey,
    Buffer.from(privateKeyPem, "utf8"),
  );
  return { salt, iv, authTag, ciphertext, kdf: params };
}

/**
 * Restore a private-key PEM from a {@link RecoveryBackup} using the recovery
 * passphrase (R23.2). Runs entirely on the client during reinstall/new-device
 * setup; the plaintext private key is never transmitted to the API. Throws
 * {@link DecryptionIntegrityError} if the passphrase is wrong or the backup was
 * tampered with.
 */
export async function restoreFromRecoveryBackup(
  backup: RecoveryBackup,
  passphrase: string,
): Promise<string> {
  if (backup.iv.length !== IV_BYTES || backup.authTag.length !== AUTH_TAG_BYTES) {
    throw new RangeError("malformed recovery backup: bad iv/authTag length");
  }
  const recoveryKey = await deriveRecoveryKey(passphrase, backup.salt, backup.kdf);
  const pem = aesGcmDecrypt(
    recoveryKey,
    backup.iv,
    backup.ciphertext,
    backup.authTag,
  );
  return pem.toString("utf8");
}
