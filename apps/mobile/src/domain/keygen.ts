/**
 * RSA-2048 asymmetric key generation (R1.4).
 *
 * On account creation the app generates an RSA-2048 key pair whose private key
 * is stored in the Secure_Enclave and whose public key is registered with the
 * Kshema_API for Encrypted_Black_Box key wrapping. RSA-OAEP(SHA-256) is the
 * envelope scheme shared with `@kshema/encryption`, so this key pair is
 * directly usable to unwrap black-box symmetric keys.
 *
 * Key generation is abstracted behind {@link KeyPairGenerator} so the identity
 * flow is testable under Node and swappable for a native RSA implementation on
 * device. The default generator uses Node's WebCrypto-compatible `crypto`
 * module and emits SPKI (public) / PKCS#8 (private) PEM — the same encodings
 * `@kshema/encryption` accepts.
 */
import { generateKeyPair as nodeGenerateKeyPair } from "node:crypto";

/** RSA modulus length in bits (R1.4 — RSA-2048). */
export const RSA_MODULUS_LENGTH = 2048 as const;

/** A PEM-encoded RSA key pair. The private half never leaves the device. */
export interface KeyPairPem {
  /** SPKI `-----BEGIN PUBLIC KEY-----` PEM. Registered with the API. */
  readonly publicKeyPem: string;
  /** PKCS#8 `-----BEGIN PRIVATE KEY-----` PEM. Stored only in Secure_Enclave. */
  readonly privateKeyPem: string;
}

/** Generates fresh asymmetric key pairs. Implemented per platform. */
export interface KeyPairGenerator {
  generateRsaKeyPair(): Promise<KeyPairPem>;
}

/**
 * Node/WebCrypto RSA-2048 generator. Used by the domain layer and tests; a
 * native binding with the same contract is used on device.
 */
export const nodeKeyPairGenerator: KeyPairGenerator = {
  generateRsaKeyPair() {
    return new Promise<KeyPairPem>((resolve, reject) => {
      nodeGenerateKeyPair(
        "rsa",
        {
          modulusLength: RSA_MODULUS_LENGTH,
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        },
        (err, publicKey, privateKey) => {
          if (err) {
            reject(err);
            return;
          }
          resolve({
            publicKeyPem: publicKey.toString(),
            privateKeyPem: privateKey.toString(),
          });
        },
      );
    });
  },
};

/** True for a PEM string that carries a PUBLIC key (never a private key). */
export function isPublicKeyPem(pem: string): boolean {
  return /-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(pem);
}

/** True for a PEM string that carries a PRIVATE key. */
export function isPrivateKeyPem(pem: string): boolean {
  return /-----BEGIN (?:RSA |ENCRYPTED )?PRIVATE KEY-----/.test(pem);
}
