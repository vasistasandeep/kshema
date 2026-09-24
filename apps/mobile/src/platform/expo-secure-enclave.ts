/**
 * Expo binding of the {@link SecureEnclave} contract over `expo-secure-store`
 * (R1.4, R1.8).
 *
 * `expo-secure-store` persists to the iOS Keychain / Android Keystore. We pin
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` so the private key is readable only while the
 * device is unlocked and never migrates to a backup or another device except
 * through the explicit Key_Recovery flow. `requireAuthentication` gates reads
 * behind device biometrics where available.
 */
import * as SecureStore from "expo-secure-store";
import type { SecureEnclave } from "../domain/secure-enclave.js";

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  requireAuthentication: false,
};

/** Build the production {@link SecureEnclave} backed by `expo-secure-store`. */
export function makeExpoSecureEnclave(
  options: SecureStore.SecureStoreOptions = OPTIONS,
): SecureEnclave {
  return {
    async getItem(key) {
      return SecureStore.getItemAsync(key, options);
    },
    async setItem(key, value) {
      await SecureStore.setItemAsync(key, value, options);
    },
    async deleteItem(key) {
      await SecureStore.deleteItemAsync(key, options);
    },
    async hasItem(key) {
      return (await SecureStore.getItemAsync(key, options)) !== null;
    },
  };
}
