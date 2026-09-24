/**
 * Cryptographic identity onboarding (R1.4, R1.5, R1.8).
 *
 * On account creation the app:
 *   1. generates an RSA-2048 key pair (R1.4),
 *   2. stores the PRIVATE key in the Secure_Enclave — and nowhere else (R1.8),
 *   3. yields a registration payload carrying ONLY the PUBLIC key for the API
 *      (R1.5).
 *
 * `createIdentity` returns the public-key registration DTO shape that maps onto
 * the API's `otp/verify` body (`clientPublicKeyPem`). The private key is never
 * part of any returned value that is API-bound: the only place it lives is the
 * enclave. A guard rejects any attempt to build a registration payload that
 * accidentally includes private-key material.
 */
import {
  isPublicKeyPem,
  isPrivateKeyPem,
  type KeyPairGenerator,
} from "./keygen.js";
import {
  ENCLAVE_KEYS,
  type SecureEnclave,
} from "./secure-enclave.js";

export interface IdentityDeps {
  readonly enclave: SecureEnclave;
  readonly keygen: KeyPairGenerator;
}

/**
 * The public-only material the client registers with the Kshema_API. Mirrors
 * `OtpVerify.clientPublicKeyPem` in `@kshema/types` — deliberately no private
 * field exists on this type (R1.8).
 */
export interface PublicKeyRegistration {
  readonly clientPublicKeyPem: string;
}

/** Raised if a registration payload would ever carry private-key material. */
export class PrivateKeyLeakError extends Error {
  constructor() {
    super("Refusing to build an API payload containing private-key material (R1.8)");
    this.name = "PrivateKeyLeakError";
  }
}

export interface CreateIdentityResult {
  /** Safe-to-transmit public key registration DTO (R1.5). */
  readonly registration: PublicKeyRegistration;
  /** The generated public key PEM (also cached in the enclave for convenience). */
  readonly publicKeyPem: string;
}

/**
 * Generate a fresh identity, persist the private key to the Secure_Enclave, and
 * return the public-only registration payload for the API. Overwrites any
 * existing identity in the enclave.
 */
export async function createIdentity(
  deps: IdentityDeps,
): Promise<CreateIdentityResult> {
  const { publicKeyPem, privateKeyPem } = await deps.keygen.generateRsaKeyPair();

  // Private key -> Secure_Enclave only (R1.4, R1.8).
  await deps.enclave.setItem(ENCLAVE_KEYS.privateKeyPem, privateKeyPem);
  await deps.enclave.setItem(ENCLAVE_KEYS.publicKeyPem, publicKeyPem);

  return {
    registration: buildRegistration(publicKeyPem),
    publicKeyPem,
  };
}

/**
 * Build the API registration payload from a public key PEM, rejecting anything
 * that is not a public key (or that smells like a private key). This is the
 * single choke point through which key material reaches an API DTO (R1.8).
 */
export function buildRegistration(publicKeyPem: string): PublicKeyRegistration {
  if (isPrivateKeyPem(publicKeyPem) || !isPublicKeyPem(publicKeyPem)) {
    throw new PrivateKeyLeakError();
  }
  return { clientPublicKeyPem: publicKeyPem };
}

/** Whether an identity (private key) already exists in the enclave. */
export async function hasIdentity(deps: IdentityDeps): Promise<boolean> {
  const pem = await deps.enclave.getItem(ENCLAVE_KEYS.privateKeyPem);
  return !!pem && isPrivateKeyPem(pem);
}

/** Read the enclave-held public key PEM, if an identity exists. */
export async function getPublicKeyPem(
  deps: IdentityDeps,
): Promise<string | null> {
  return deps.enclave.getItem(ENCLAVE_KEYS.publicKeyPem);
}
