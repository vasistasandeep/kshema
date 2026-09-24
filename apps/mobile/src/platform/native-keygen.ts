/**
 * Native RSA-2048 keygen binding (R1.4).
 *
 * On device, RSA-2048 generation runs in the platform crypto layer so the key
 * can be created hardware-backed and the private half handed straight to the
 * Secure_Enclave. Expo Go ships `expo-crypto` (hashing / random bytes) but not
 * RSA keypair generation, so a dev/custom build wires a native RSA module
 * (e.g. `react-native-rsa-native`, which returns SPKI/PKCS#8 PEM) behind this
 * adapter. The domain layer and tests use `nodeKeyPairGenerator` instead, which
 * shares the exact same {@link KeyPairGenerator} contract and PEM encodings.
 */
import type { KeyPairGenerator, KeyPairPem } from "../domain/keygen.js";
import { RSA_MODULUS_LENGTH } from "../domain/keygen.js";

/**
 * The narrow shape we need from a native RSA module. Kept as an injected
 * dependency so this file has no hard import on an optional native package and
 * still typechecks in the app build.
 */
export interface NativeRsaModule {
  generateKeys(keySize: number): Promise<{ public: string; private: string }>;
}

/**
 * Build a {@link KeyPairGenerator} from a native RSA module. The returned PEMs
 * must be SPKI (public) / PKCS#8 (private) to stay compatible with
 * `@kshema/encryption`.
 */
export function makeNativeKeyPairGenerator(
  rsa: NativeRsaModule,
): KeyPairGenerator {
  return {
    async generateRsaKeyPair(): Promise<KeyPairPem> {
      const { public: publicKeyPem, private: privateKeyPem } =
        await rsa.generateKeys(RSA_MODULUS_LENGTH);
      return { publicKeyPem, privateKeyPem };
    },
  };
}
