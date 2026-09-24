import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Body, PrimaryButton, Screen, Title } from "../../src/components/primitives";
import {
  DISCLAIMER_STATEMENTS,
  recordDisclaimerAcceptance,
} from "../../src/domain/disclaimer";
import { useSessionStore } from "../../src/stores/hooks";

/**
 * Mandatory Safety_Disclaimer gate (R26.1, R26.2, R26.3, R26.4). Ambient_Shield
 * cannot activate until the user explicitly accepts (R26.2); acceptance is
 * recorded with version + timestamp (R26.3). Copy is drawn from
 * `DISCLAIMER_STATEMENTS`, which is asserted Banned_Term-free in tests (R26.4).
 */
export default function Disclaimer() {
  const router = useRouter();
  const acceptDisclaimer = useSessionStore((s) => s.acceptDisclaimer);
  const [checked, setChecked] = useState(false);

  function accept() {
    acceptDisclaimer(recordDisclaimerAcceptance());
    router.replace("/onboarding/preferred-name");
  }

  return (
    <Screen>
      <Title>Before we begin</Title>
      <View className="gap-3">
        {DISCLAIMER_STATEMENTS.map((line) => (
          <Body key={line}>• {line}</Body>
        ))}
      </View>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        onPress={() => setChecked((v) => !v)}
        className="flex-row items-center gap-3"
      >
        <View
          className={`h-6 w-6 rounded-md border ${
            checked ? "bg-primary-action" : "border-temple-brass/60"
          }`}
        />
        <Text className="text-base text-typography">
          I have read and accept these terms.
        </Text>
      </Pressable>
      <PrimaryButton label="Accept and continue" onPress={accept} disabled={!checked} />
    </Screen>
  );
}
