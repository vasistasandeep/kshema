import { useState } from "react";
import { TextInput } from "react-native";
import { useRouter } from "expo-router";
import { Body, PrimaryButton, Screen, Title } from "../../src/components/primitives";
import {
  isValidPreferredName,
  normalizePreferredName,
} from "../../src/domain/preferred-name";
import { useSessionStore } from "../../src/stores/hooks";

/**
 * Preferred display-name prompt (R1.7). Shown before the user joins a Circle
 * when no name is on file. The name is stored locally (and posted to the API,
 * which persists it per R1.6).
 */
export default function PreferredName() {
  const router = useRouter();
  const setPreferredName = useSessionStore((s) => s.setPreferredName);
  const [name, setName] = useState("");

  function save() {
    setPreferredName(normalizePreferredName(name));
    router.replace("/onboarding/join-circle");
  }

  return (
    <Screen>
      <Title>What should we call you?</Title>
      <Body>
        Your Circle will see this warm, familiar name in every update — not a
        username or ID.
      </Body>
      <TextInput
        className="rounded-xl border border-temple-brass/40 px-4 py-3 text-typography"
        placeholder="Preferred name"
        value={name}
        onChangeText={setName}
        autoFocus
      />
      <PrimaryButton
        label="Continue"
        onPress={save}
        disabled={!isValidPreferredName(name)}
      />
    </Screen>
  );
}
