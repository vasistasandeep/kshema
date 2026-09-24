/**
 * Secure_Enclave abstraction (R1.4, R1.8).
 *
 * The Anchor/Observer RSA private key MUST live exclusively in the device
 * hardware-backed key store — Keychain on iOS, Keystore on Android — and MUST
 * never be transmitted to the Kshema_API (R1.8). To keep that guarantee
 * testable and platform-independent, all identity/recovery logic depends on
 * this narrow interface rather than on `expo-secure-store` directly.
 *
 * The Expo binding (`makeExpoSecureEnclave`, see `../platform/expo-secure-enclave`)
 * implements this over `expo-secure-store` with
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` + biometric access control. Tests use the
 * in-memory implementation below.
 */

/** Well-known Secure_Enclave item keys used by the app. */
export const ENCLAVE_KEYS = {
  /** The PEM-encoded RSA-2048 PRIVATE key. Never leaves the device. */
  privateKeyPem: "kshema.identity.privateKeyPem",
  /** The PEM-encoded RSA-2048 PUBLIC key (safe to share / register with API). */
  publicKeyPem: "kshema.identity.publicKeyPem",
} as const;

export type EnclaveKey = (typeof ENCLAVE_KEYS)[keyof typeof ENCLAVE_KEYS];

/**
 * Hardware-backed secret store. Deliberately tiny: get / set / delete / has.
 * Implementations MUST persist values so they survive process restarts and
 * MUST require device unlock (and, where configured, biometric) to read.
 */
export interface SecureEnclave {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
  hasItem(key: string): Promise<boolean>;
}

/**
 * In-memory {@link SecureEnclave} for tests and for the framework-agnostic
 * domain layer. It models the enclave contract (values persist for the life of
 * the instance) without any native dependency. NOT for production use.
 */
export function createInMemoryEnclave(
  seed?: Record<string, string>,
): SecureEnclave {
  const store = new Map<string, string>(seed ? Object.entries(seed) : undefined);
  return {
    async getItem(key) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    async setItem(key, value) {
      store.set(key, value);
    },
    async deleteItem(key) {
      store.delete(key);
    },
    async hasItem(key) {
      return store.has(key);
    },
  };
}
