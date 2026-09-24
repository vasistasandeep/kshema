import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import {
  Body,
  Card,
  PrimaryButton,
  Screen,
  Title,
} from "../../src/components/primitives";
import { DecryptionIntegrityError } from "@kshema/encryption";
import {
  NoRecoveryBackupError,
  PlatformKeyStoreUnavailableError,
  provisionRecovery,
  restoreIdentity,
} from "../../src/domain/key-recovery";
import { recoveryDeps } from "../../src/runtime";
import { useSessionStore } from "../../src/stores/hooks";

/**
 * Settings incl. the Key_Recovery flow (R23).
 *
 *  • Set up recovery (R23.1): encrypt the enclave private key under a passphrase
 *    and sync the encrypted backup to the platform key store.
 *  • Restore (R23.2): pull the encrypted backup and decrypt it locally with the
 *    passphrase, re-seating the private key into the enclave. A wrong passphrase
 *    surfaces a friendly error (DecryptionIntegrityError) and never exposes the
 *    key. When the platform key store is unavailable we point the user to the
 *    admin re-invite fallback (R23.3).
 */
export default function Settings() {
  const [passphrase, setPassphrase] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const markIdentityCreated = useSessionStore((s) => s.markIdentityCreated);

  async function setup() {
    setStatus(null);
    try {
      await provisionRecovery(recoveryDeps, passphrase);
      setStatus("Recovery backup saved to your device key store.");
    } catch (err) {
      setStatus(explain(err));
    }
  }

  async function restore() {
    setStatus(null);
    try {
      await restoreIdentity(recoveryDeps, passphrase);
      markIdentityCreated();
      setStatus("Your identity was restored on this device.");
    } catch (err) {
      setStatus(explain(err));
    }
  }

  return (
    <Screen>
      <Title>Settings</Title>
      <Card>
        <Body>Key recovery</Body>
        <Body>
          Choose a recovery passphrase. It protects an encrypted backup of your
          private key so you can restore it on a new device. We never see this
          passphrase or your key.
        </Body>
        <TextInput
          className="rounded-xl border border-temple-brass/40 px-4 py-3 text-typography"
          placeholder="Recovery passphrase"
          secureTextEntry
          value={passphrase}
          onChangeText={setPassphrase}
        />
        <PrimaryButton
          label="Set up recovery"
          onPress={setup}
          disabled={passphrase.length < 8}
        />
        <PrimaryButton
          label="Restore from backup"
          onPress={restore}
          disabled={passphrase.length < 8}
        />
        {status ? (
          <View>
            <Text className="text-sm text-typography">{status}</Text>
          </View>
        ) : null}
      </Card>
    </Screen>
  );
}

function explain(err: unknown): string {
  if (err instanceof DecryptionIntegrityError) {
    return "That passphrase did not match. Please try again.";
  }
  if (err instanceof NoRecoveryBackupError) {
    return "No backup was found on this account yet.";
  }
  if (err instanceof PlatformKeyStoreUnavailableError) {
    return "Your device cloud key store is unavailable. A Circle admin can re-invite you with a fresh key.";
  }
  return "Something went wrong. Please try again.";
}
