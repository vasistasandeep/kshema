import { describe, expect, it } from "vitest";
import { DecryptionIntegrityError } from "@kshema/encryption";
import { createIdentity } from "./identity.js";
import { nodeKeyPairGenerator } from "./keygen.js";
import {
  ENCLAVE_KEYS,
  createInMemoryEnclave,
  type SecureEnclave,
} from "./secure-enclave.js";
import {
  createInMemoryPlatformKeyStore,
  type PlatformKeyStore,
} from "./platform-key-store.js";
import {
  hasRecoveryBackup,
  MissingPrivateKeyError,
  NoRecoveryBackupError,
  PlatformKeyStoreUnavailableError,
  provisionRecovery,
  restoreIdentity,
} from "./key-recovery.js";

const PASSPHRASE = "correct horse battery staple";

async function seededDevice(): Promise<{
  enclave: SecureEnclave;
  keyStore: PlatformKeyStore;
  privateKeyPem: string;
}> {
  const enclave = createInMemoryEnclave();
  await createIdentity({ enclave, keygen: nodeKeyPairGenerator });
  const privateKeyPem = (await enclave.getItem(
    ENCLAVE_KEYS.privateKeyPem,
  )) as string;
  return { enclave, keyStore: createInMemoryPlatformKeyStore(), privateKeyPem };
}

describe("Key_Recovery provision + restore (R23.1, R23.2)", () => {
  it("provisions an encrypted backup to the platform key store", async () => {
    const { enclave, keyStore } = await seededDevice();
    const deps = { enclave, keyStore };

    await provisionRecovery(deps, PASSPHRASE);

    expect(await hasRecoveryBackup(deps)).toBe(true);
    // The stored backup must be ciphertext — never the plaintext private key.
    const raw = (await keyStore.read("kshema.recovery.backup.v1")) as string;
    expect(raw).not.toContain("PRIVATE KEY");
  });

  it("restores the exact same private key onto a fresh device (R23.2)", async () => {
    const source = await seededDevice();
    await provisionRecovery(
      { enclave: source.enclave, keyStore: source.keyStore },
      PASSPHRASE,
    );

    // New device: empty enclave, but the SAME cloud key store is signed in.
    const newEnclave = createInMemoryEnclave();
    const { privateKeyPem } = await restoreIdentity(
      { enclave: newEnclave, keyStore: source.keyStore },
      PASSPHRASE,
    );

    expect(privateKeyPem).toBe(source.privateKeyPem);
    expect(await newEnclave.getItem(ENCLAVE_KEYS.privateKeyPem)).toBe(
      source.privateKeyPem,
    );
  });

  it("restore never touches an API — it is a pure enclave+keystore round trip", async () => {
    // There is no network dependency to inject; the absence of any api client
    // in the deps is the guarantee. This test documents the contract by
    // confirming restore works with only enclave + keyStore.
    const source = await seededDevice();
    await provisionRecovery(
      { enclave: source.enclave, keyStore: source.keyStore },
      PASSPHRASE,
    );
    const newEnclave = createInMemoryEnclave();
    await expect(
      restoreIdentity(
        { enclave: newEnclave, keyStore: source.keyStore },
        PASSPHRASE,
      ),
    ).resolves.toMatchObject({ privateKeyPem: source.privateKeyPem });
  });

  it("rejects a wrong passphrase with an integrity error and no key exposure", async () => {
    const source = await seededDevice();
    await provisionRecovery(
      { enclave: source.enclave, keyStore: source.keyStore },
      PASSPHRASE,
    );
    const newEnclave = createInMemoryEnclave();

    await expect(
      restoreIdentity(
        { enclave: newEnclave, keyStore: source.keyStore },
        "wrong passphrase entirely",
      ),
    ).rejects.toBeInstanceOf(DecryptionIntegrityError);
    // Nothing was seated into the new enclave on failure.
    expect(await newEnclave.getItem(ENCLAVE_KEYS.privateKeyPem)).toBeNull();
  });
});

describe("Key_Recovery error paths (R23.3)", () => {
  it("throws MissingPrivateKeyError when there is no key to back up", async () => {
    const deps = {
      enclave: createInMemoryEnclave(),
      keyStore: createInMemoryPlatformKeyStore(),
    };
    await expect(provisionRecovery(deps, PASSPHRASE)).rejects.toBeInstanceOf(
      MissingPrivateKeyError,
    );
  });

  it("surfaces the admin re-invite fallback when the key store is unavailable", async () => {
    const { enclave } = await seededDevice();
    const deps = {
      enclave,
      keyStore: createInMemoryPlatformKeyStore({ available: false }),
    };
    await expect(provisionRecovery(deps, PASSPHRASE)).rejects.toBeInstanceOf(
      PlatformKeyStoreUnavailableError,
    );
  });

  it("throws NoRecoveryBackupError when restoring with no backup present", async () => {
    const deps = {
      enclave: createInMemoryEnclave(),
      keyStore: createInMemoryPlatformKeyStore(),
    };
    await expect(restoreIdentity(deps, PASSPHRASE)).rejects.toBeInstanceOf(
      NoRecoveryBackupError,
    );
  });
});
