/**
 * Expo binding of the {@link PlatformKeyStore} contract for Key_Recovery backup
 * sync (R23.1).
 *
 * The encrypted recovery backup is written to a *synchronizable* Keychain /
 * Keystore entry so it rides the OS cloud key store (iCloud Keychain / Google
 * Password Manager) to the user's other devices. On iOS this is expressed via
 * `keychainAccessible: AFTER_FIRST_UNLOCK` combined with a synchronizable item;
 * `expo-secure-store` exposes the accessibility knob, and the native module is
 * configured to mark recovery entries synchronizable. Only the *encrypted*
 * backup is stored — never the plaintext key.
 */
import * as SecureStore from "expo-secure-store";
import type { PlatformKeyStore } from "../domain/platform-key-store.js";

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

/** Build the production {@link PlatformKeyStore} backed by the cloud key store. */
export function makeExpoPlatformKeyStore(
  options: SecureStore.SecureStoreOptions = OPTIONS,
): PlatformKeyStore {
  return {
    async read(slot) {
      return SecureStore.getItemAsync(slot, options);
    },
    async write(slot, value) {
      await SecureStore.setItemAsync(slot, value, options);
    },
    async remove(slot) {
      await SecureStore.deleteItemAsync(slot, options);
    },
    async isAvailable() {
      return SecureStore.isAvailableAsync();
    },
  };
}
