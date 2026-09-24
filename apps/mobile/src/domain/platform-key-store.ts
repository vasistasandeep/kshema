/**
 * Platform key-store backup channel for Key_Recovery (R23.1).
 *
 * The encrypted private-key backup (see `@kshema/encryption` `RecoveryBackup`)
 * is synced to the OS-managed cloud key store — iCloud Keychain on iOS, Google
 * Password Manager on Android — so a user can restore their decryption
 * identity on a new device (R23.2). Only the *encrypted* backup is stored here;
 * the passphrase that unlocks it is known only to the user, so neither the
 * platform vendor nor the Kshema_API can read the private key.
 *
 * Abstracted behind {@link PlatformKeyStore} so the recovery flow is testable
 * and platform-swappable. The Expo binding writes to synchronizable Keychain /
 * Keystore entries.
 */

/** Well-known backup slot key for the recovery backup blob. */
export const RECOVERY_BACKUP_SLOT = "kshema.recovery.backup.v1" as const;

/**
 * A cloud-synchronized key/value store for *encrypted* backups only. Values are
 * opaque strings (serialized {@link import("./key-recovery").SerializedRecoveryBackup}).
 */
export interface PlatformKeyStore {
  /** Read a previously synced backup, or null if none exists on this account. */
  read(slot: string): Promise<string | null>;
  /** Write/overwrite a backup into the synchronizable slot. */
  write(slot: string, value: string): Promise<void>;
  /** Remove a backup slot. */
  remove(slot: string): Promise<void>;
  /**
   * Whether the platform cloud key store is currently available (signed in to
   * iCloud / Google, sync enabled). Drives the R23.3 fallback path.
   */
  isAvailable(): Promise<boolean>;
}

/** In-memory {@link PlatformKeyStore} for tests / domain layer. */
export function createInMemoryPlatformKeyStore(options?: {
  available?: boolean;
  seed?: Record<string, string>;
}): PlatformKeyStore {
  const available = options?.available ?? true;
  const store = new Map<string, string>(
    options?.seed ? Object.entries(options.seed) : undefined,
  );
  return {
    async read(slot) {
      return store.has(slot) ? (store.get(slot) as string) : null;
    },
    async write(slot, value) {
      store.set(slot, value);
    },
    async remove(slot) {
      store.delete(slot);
    },
    async isAvailable() {
      return available;
    },
  };
}
